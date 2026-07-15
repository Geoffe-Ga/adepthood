"""LLM cost-metering pipeline (LLMUsageLog writes on resonance + essay).

Covers the write path both endpoints call before their commit:
``record_llm_usage`` accumulating one row per successful ``complete()`` call,
skipping stub-provider responses, and recording ``None`` cost for an unpriced
model. Both ``run_resonance`` and ``expand_marginalia_essay`` await
``record_llm_usage`` before committing, so these tests assert that contract.
"""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from models.goal import Goal
from models.habit import Habit
from models.journal_entry import JournalEntry
from models.llm_usage_log import LLMUsageLog
from models.marginalia import Marginalia, MarginaliaKind
from models.user import User
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, LLMProviderError, LLMResponse
from services.llm_pricing import estimate_cost_usd

_BODY = "I walked by the river and the willow bent without breaking."
_PRICED_MODEL = "gpt-4o-mini"


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Sign up a user and return (auth headers, user_id)."""
    email = f"{username}@example.com"
    resp = await client.post(
        "/auth/signup",
        json={"email": email, "password": "secret12345"},  # pragma: allowlist secret
    )
    assert resp.status_code == HTTPStatus.OK
    payload = resp.json()
    return {"Authorization": f"Bearer {payload['token']}"}, int(payload["user_id"])


async def _promote_to_admin(db_session: AsyncSession, user_id: int) -> None:
    await db_session.execute(update(User).where(col(User.id) == user_id).values(is_admin=True))
    await db_session.commit()


async def _signup_admin(client: AsyncClient, db_session: AsyncSession) -> dict[str, str]:
    headers, user_id = await _signup(client, "metering_admin")
    await _promote_to_admin(db_session, user_id)
    return headers


async def _create_entry(client: AsyncClient, headers: dict[str, str], body: str = _BODY) -> int:
    resp = await client.post("/journal/", json={"message": body}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    return int(resp.json()["id"])


async def _seed_habit(session: AsyncSession, user_id: int, name: str = "Meditation") -> None:
    """Seed one habit with a clear-tier goal so gather_candidates is non-empty."""
    habit = Habit(
        name=name,
        icon="flame",
        start_date=date(2025, 1, 1),
        energy_cost=1,
        energy_return=2,
        user_id=user_id,
    )
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    session.add(
        Goal(
            habit_id=habit.id,
            title="clear",
            tier="clear",
            target=1.0,
            target_unit="x",
            frequency=1.0,
            frequency_unit="per_day",
            is_additive=True,
        )
    )
    await session.commit()


async def _usage_rows_for_entry(session: AsyncSession, entry_id: int) -> list[LLMUsageLog]:
    result = await session.execute(
        select(LLMUsageLog).where(col(LLMUsageLog.journal_entry_id) == entry_id)
    )
    return list(result.scalars().all())


def _stub_response(text: str) -> LLMResponse:
    return LLMResponse(
        text=text, provider="stub", model=STUB_MODEL_NAME, prompt_tokens=0, completion_tokens=0
    )


def _priced_response(
    text: str,
    *,
    model: str = _PRICED_MODEL,
    prompt_tokens: int = 1000,
    completion_tokens: int = 500,
) -> LLMResponse:
    return LLMResponse(
        text=text,
        provider="openai",
        model=model,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )


# ---------------------------------------------------------------------------
# 1. Priced row on the resonance path + admin dashboard reflects it
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_priced_resonance_call_writes_row_admin_reflects_it(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A single priced marginalia call writes exactly one LLMUsageLog row the admin sees."""
    notes_payload = json.dumps(
        {"notes": [{"kind": "theme", "quote": "I walked by the river", "note": "You return."}]}
    )

    async def _complete(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del prompt, history, system_prompt, api_key
        return _priced_response(notes_payload)

    monkeypatch.setattr(marginalia_service, "generate_response", _complete)

    headers, _ = await _signup(async_client, "priced_one")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK

    rows = await _usage_rows_for_entry(db_session, entry_id)
    assert len(rows) == 1
    row = rows[0]
    assert row.provider == "openai"
    assert row.model == _PRICED_MODEL
    assert row.prompt_tokens == 1000
    assert row.completion_tokens == 500
    assert row.total_tokens == 1500
    expected_cost = estimate_cost_usd(_PRICED_MODEL, 1000, 500)
    assert expected_cost == Decimal("0.000450")
    assert row.estimated_cost_usd == expected_cost

    admin_headers = await _signup_admin(async_client, db_session)
    stats_resp = await async_client.get("/admin/usage-stats", headers=admin_headers)
    assert stats_resp.status_code == HTTPStatus.OK
    data = stats_resp.json()
    assert data["total_calls"] == 1
    assert data["total_prompt_tokens"] == 1000
    assert data["total_completion_tokens"] == 500
    assert data["total_tokens"] == 1500
    assert Decimal(data["total_estimated_cost_usd"]) == Decimal("0.000450")


# ---------------------------------------------------------------------------
# 2. Two complete() calls accumulate two rows (not last-call-wins)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_two_llm_calls_accumulate_two_usage_rows(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Marginalia + detection each write a row -- the adapter accumulates, not overwrites."""
    notes_payload = json.dumps(
        {"notes": [{"kind": "theme", "quote": "I meditated", "note": "You return."}]}
    )
    hits_payload = json.dumps({"hits": [{"index": 0, "quote": "I meditated"}]})

    async def _complete(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del history, system_prompt, api_key
        if '"hits"' in prompt or "COMPLETED" in prompt:
            return _priced_response(
                hits_payload, model="gpt-4o", prompt_tokens=200, completion_tokens=50
            )
        return _priced_response(notes_payload)

    monkeypatch.setattr(marginalia_service, "generate_response", _complete)

    headers, user_id = await _signup(async_client, "two_calls")
    await _seed_habit(db_session, user_id)
    entry_id = await _create_entry(async_client, headers, body="I meditated by the river today.")

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK

    rows = await _usage_rows_for_entry(db_session, entry_id)
    assert len(rows) == 2
    models = sorted(row.model for row in rows)
    assert models == sorted([_PRICED_MODEL, "gpt-4o"])


# ---------------------------------------------------------------------------
# 3. Stub-provider responses are skipped; a sibling priced call still logs
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stub_provider_is_skipped_alongside_a_priced_sibling_call(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Detection's stub reply is skipped; marginalia's priced reply still logs."""
    notes_payload = json.dumps(
        {"notes": [{"kind": "theme", "quote": "I meditated", "note": "You return."}]}
    )
    hits_payload = json.dumps({"hits": [{"index": 0, "quote": "I meditated"}]})

    async def _complete(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del history, system_prompt, api_key
        if '"hits"' in prompt or "COMPLETED" in prompt:
            return _stub_response(hits_payload)
        return _priced_response(notes_payload)

    monkeypatch.setattr(marginalia_service, "generate_response", _complete)

    headers, user_id = await _signup(async_client, "stub_skip")
    await _seed_habit(db_session, user_id)
    entry_id = await _create_entry(async_client, headers, body="I meditated by the river today.")

    with caplog.at_level("WARNING"):
        resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK

    rows = await _usage_rows_for_entry(db_session, entry_id)
    assert len(rows) == 1
    assert rows[0].provider == "openai"
    assert rows[0].model == _PRICED_MODEL
    # The skipped stub call must never reach the pricing table.
    assert "llm_pricing_unknown_model" not in caplog.text


# ---------------------------------------------------------------------------
# 4. An unknown real model still writes a row, with a None cost
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unknown_model_writes_row_with_null_cost(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A priced-provider call against an unrated model logs the row with a None cost."""
    notes_payload = json.dumps(
        {"notes": [{"kind": "theme", "quote": "I walked by the river", "note": "You return."}]}
    )

    async def _complete(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del prompt, history, system_prompt, api_key
        return _priced_response(notes_payload, model="not-in-pricing-table")

    monkeypatch.setattr(marginalia_service, "generate_response", _complete)

    headers, _ = await _signup(async_client, "unknown_model")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK

    rows = await _usage_rows_for_entry(db_session, entry_id)
    assert len(rows) == 1
    assert rows[0].model == "not-in-pricing-table"
    assert rows[0].estimated_cost_usd is None


# ---------------------------------------------------------------------------
# 5. A provider error writes zero rows -- metering never happens on failure
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_provider_error_writes_zero_rows(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failed LLM call must never leave a partial LLMUsageLog row behind."""

    async def _boom(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del prompt, history, system_prompt, api_key
        raise LLMProviderError("provider down")

    monkeypatch.setattr(marginalia_service, "generate_response", _boom)

    headers, _ = await _signup(async_client, "provider_err")
    entry_id = await _create_entry(async_client, headers)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.BAD_GATEWAY

    rows = await _usage_rows_for_entry(db_session, entry_id)
    assert rows == []


# ---------------------------------------------------------------------------
# 6. Essay path: a priced call writes one row FK'd to the entry
# ---------------------------------------------------------------------------


async def _seed_marginalia(
    session: AsyncSession, user_id: int, body: str = _BODY
) -> tuple[int, int]:
    """Persist an entry + one marginalia row; return (marginalia_id, entry_id)."""
    entry = JournalEntry(sender="user", user_id=user_id, message=body)
    session.add(entry)
    await session.flush()
    assert entry.id is not None
    note = Marginalia(
        journal_entry_id=entry.id,
        user_id=user_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=0,
        anchor_end=6,
        anchor_text="I walk",
        note="A beginning.",
    )
    session.add(note)
    await session.commit()
    await session.refresh(note)
    assert note.id is not None
    return note.id, entry.id


@pytest.mark.asyncio
async def test_essay_priced_call_writes_one_row(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A priced essay-generation call writes one LLMUsageLog row FK'd to the note's entry."""
    headers, user_id = await _signup(async_client, "essay_metering")
    marg_id, entry_id = await _seed_marginalia(db_session, user_id)

    async def _complete(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del prompt, history, system_prompt, api_key
        return _priced_response(
            "A warm letter about beginnings.", prompt_tokens=800, completion_tokens=200
        )

    monkeypatch.setattr(marginalia_service, "generate_response", _complete)

    resp = await async_client.post(f"/journal/marginalia/{marg_id}/essay", headers=headers)
    assert resp.status_code == HTTPStatus.OK

    rows = await _usage_rows_for_entry(db_session, entry_id)
    assert len(rows) == 1
    row = rows[0]
    assert row.provider == "openai"
    assert row.model == _PRICED_MODEL
    assert row.prompt_tokens == 800
    assert row.completion_tokens == 200
    assert row.estimated_cost_usd is not None
    assert row.estimated_cost_usd == estimate_cost_usd(_PRICED_MODEL, 800, 200)
