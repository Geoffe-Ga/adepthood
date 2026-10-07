"""One ``llm_generation_settled`` line per settled generation (#623 PR3).

The ratified record asks to "instrument actual input/output tokens, model, cost
estimate, refunds, and cache hits" (§1) and to "meter real input/output tokens
and corrective attempts" (§2). Each resonance pass, essay and transcription
that settles leaves exactly one settlement line whose counts equal the usage
rows it metered, whose outcome matches the wallet audit reason it wrote, and
which carries no writer text. Its usage rows share one ``generation_id`` and
its ``charged`` flag, which is what the p95 admin metric groups by.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client, get_reflection_boundary
from domain.creek_vault import CreekVaultCareEscalationError
from main import app
from models.goal import Goal
from models.habit import Habit
from models.journal_entry import JournalClassification, JournalEntry
from models.llm_usage_log import LLMUsageLog
from models.marginalia import Marginalia, MarginaliaKind
from models.wallet_audit import (
    BUCKET_MONTHLY,
    REASON_REFUND_FAILED_ESSAY,
    REASON_REFUND_FAILED_RESONANCE,
    REASON_REFUND_NO_ESSAY,
    REASON_REFUND_NO_NOTES,
    REASON_SPEND_MONTHLY,
    WalletAudit,
)
from routers import journal as journal_router
from services import marginalia as marginalia_service
from services.botmason import LLMProviderError, LLMResponse
from services.llm_pricing import estimate_cost_usd
from services.llm_usage import OUTCOME_FOR_REFUND_REASON
from services.reflection_boundary import ReflectionBoundary
from services.wallet import SpendResult, StagedRefund
from tests.helpers.log_lines import assert_no_text, production_line, records_for
from tests.support.reflecting_vault import ReflectingVaultClient
from tests.transcription_helpers import (
    JPEG_BYTES,
    SENTINEL_TEXT,
    b64,
    patch_generate_response,
    payload,
    priced_response,
)

_SETTLED = "llm_generation_settled"
_REFUND_APPLIED = "wallet_refund_applied"
_BYOK_HEADER = "X-LLM-API-Key"
_BYOK_KEY = "sk-abcdef1234567890abcdef1234567890"  # pragma: allowlist secret
_PRICED = {"price_acknowledged": True}
_MODEL = "gpt-4o-mini"
_DETECT_MODEL = "gpt-4o"
_BODY = "I meditated by the river and the willow bent without breaking."
_QUOTE = "I meditated by the river"
_NOTE = "The water keeps returning, and so do you."
_LETTER = "A warm letter about the willow, meant for the writer alone."
_DISTRESS_BODY = "I keep thinking I want to kill myself and end my life tonight."
_LOGGERS = ("routers.journal", "services.llm_usage", "services.wallet")


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, int(body["user_id"])


async def _create_entry(client: AsyncClient, headers: dict[str, str], body: str = _BODY) -> int:
    resp = await client.post("/journal/", json={"message": body}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    return int(resp.json()["id"])


async def _seed_habit(session: AsyncSession, user_id: int) -> None:
    """One habit with a clear-tier goal, so the pass makes its detection dial."""
    habit = Habit(
        name="Meditation",
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


async def _seed_marginalia(session: AsyncSession, user_id: int) -> int:
    entry = JournalEntry(sender="user", user_id=user_id, message=_BODY)
    session.add(entry)
    await session.flush()
    note = Marginalia(
        journal_entry_id=entry.id,
        user_id=user_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=0,
        anchor_end=11,
        anchor_text="I meditated",
        note=_NOTE,
    )
    session.add(note)
    await session.commit()
    await session.refresh(note)
    assert note.id is not None
    return note.id


def _notes(*quotes: str) -> str:
    return json.dumps({"notes": [{"kind": "theme", "quote": q, "note": _NOTE} for q in quotes]})


class _ScriptedLLM:
    """Answers reflection calls from a script, detection calls with one priced hit."""

    def __init__(self, *reflections: str, model: str = _MODEL) -> None:
        self.reflections = list(reflections)
        self.model = model

    async def __call__(
        self, prompt: str, history: object, *, system_prompt: str | None, api_key: object
    ) -> LLMResponse:
        del history, api_key
        task = f"{system_prompt or ''}\n{prompt}"
        if '"hits"' in task or "COMPLETED" in task:
            hits = json.dumps({"hits": [{"index": 0, "quote": "I meditated"}]})
            return LLMResponse(
                text=hits,
                provider="openai",
                model=_DETECT_MODEL,
                prompt_tokens=200,
                completion_tokens=50,
            )
        text = self.reflections.pop(0) if len(self.reflections) > 1 else self.reflections[0]
        return LLMResponse(
            text=text,
            provider="openai",
            model=self.model,
            prompt_tokens=1000,
            completion_tokens=500,
        )


async def _raise_provider_error(
    prompt: str, history: object, *, system_prompt: object, api_key: object
) -> LLMResponse:
    del prompt, history, system_prompt, api_key
    raise LLMProviderError("provider down")


async def _usage_rows(session: AsyncSession, user_id: int) -> list[LLMUsageLog]:
    session.expire_all()
    result = await session.execute(
        select(LLMUsageLog).where(col(LLMUsageLog.user_id) == user_id).order_by(col(LLMUsageLog.id))
    )
    return list(result.scalars().all())


async def _audit_reasons(session: AsyncSession, user_id: int) -> list[str]:
    result = await session.execute(
        select(WalletAudit.reason)
        .where(col(WalletAudit.user_id) == user_id)
        .order_by(col(WalletAudit.id))
    )
    return list(result.scalars())


def _capture(caplog: pytest.LogCaptureFixture) -> None:
    for name in _LOGGERS:
        caplog.set_level(logging.INFO, logger=name)
    caplog.clear()


def _fail_the_commit_after_the_next_refund(monkeypatch: pytest.MonkeyPatch) -> list[Exception]:
    """Make the first commit after the next staged refund raise, once.

    The refund is really staged (audit row and all); the commit that would make
    it durable is the thing that fails. Returns the pending failure, emptied
    once it has fired, so a test can prove the seam was reached.
    """
    real_refund = journal_router.refund_one_message
    failures: list[Exception] = [RuntimeError("commit unavailable")]

    async def _refund_then_break_commit(
        session: AsyncSession, user_id: int, spent: SpendResult, *, reason: str
    ) -> StagedRefund:
        refunded = await real_refund(session, user_id, spent, reason=reason)
        if failures:
            failure = failures.pop()

            async def _failing_commit() -> None:
                del session.commit
                raise failure

            monkeypatch.setattr(session, "commit", _failing_commit, raising=False)
        return refunded

    monkeypatch.setattr(journal_router, "refund_one_message", _refund_then_break_commit)
    return failures


def _one_settled(caplog: pytest.LogCaptureFixture) -> logging.LogRecord:
    """The request's single settlement line."""
    settled = records_for(caplog.records, _SETTLED)
    assert len(settled) == 1, [r.getMessage() for r in settled]
    return settled[0]


def _assert_matches_rows(record: logging.LogRecord, rows: list[LLMUsageLog]) -> None:
    """The line's counts are exactly the sums over the generation's usage rows."""
    extra = record.__dict__
    assert extra["calls"] == len(rows)
    assert extra["prompt_tokens"] == sum(r.prompt_tokens for r in rows)
    assert extra["completion_tokens"] == sum(r.completion_tokens for r in rows)
    costs = [r.estimated_cost_usd for r in rows]
    expected = None if None in costs else sum((c for c in costs if c is not None), Decimal(0))
    assert extra["cost_usd"] == (None if expected is None else format(expected, "f"))
    assert {r.generation_id for r in rows} == {extra["generation_id"]}
    assert {r.charged for r in rows} == {extra["charged"]}


# --- Resonance -------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_kept_server_paid_pass_settles_charged_from_the_monthly_bucket(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A delivered pass: kept, charged, one attempt, counts equal to its usage row."""
    monkeypatch.setattr(marginalia_service, "generate_response", _ScriptedLLM(_notes(_QUOTE)))
    headers, user_id = await _signup(async_client, "settle_kept")
    entry_id = await _create_entry(async_client, headers)
    _capture(caplog)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert len(resp.json()["marginalia"]) == 1
    record = _one_settled(caplog)
    extra = record.__dict__
    assert extra["feature"] == "resonance"
    assert extra["outcome"] == "kept"
    assert extra["charged"] is True
    assert extra["bucket"] == BUCKET_MONTHLY
    assert extra["attempts"] == 1
    assert extra["user_id"] == user_id
    assert extra["model"] == _MODEL
    rows = await _usage_rows(db_session, user_id)
    assert len(rows) == 1
    assert extra["cost_usd"] == format(estimate_cost_usd(_MODEL, 1000, 500), "f")
    _assert_matches_rows(record, rows)
    assert "outcome=kept" in production_line(record)
    assert records_for(caplog.records, _REFUND_APPLIED) == []
    assert_no_text(caplog.records, _BODY, _NOTE, _QUOTE)


@pytest.mark.asyncio
async def test_a_kept_byok_pass_settles_uncharged(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The writer's own key paid: charged=False, no bucket, rows marked uncharged."""
    monkeypatch.setattr(marginalia_service, "generate_response", _ScriptedLLM(_notes(_QUOTE)))
    headers, user_id = await _signup(async_client, "settle_byok")
    entry_id = await _create_entry(async_client, headers)
    _capture(caplog)

    resp = await async_client.post(
        f"/journal/{entry_id}/resonance", headers={**headers, _BYOK_HEADER: _BYOK_KEY}
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    record = _one_settled(caplog)
    assert record.__dict__["charged"] is False
    assert record.__dict__["bucket"] is None
    assert record.__dict__["outcome"] == "kept"
    _assert_matches_rows(record, await _usage_rows(db_session, user_id))
    assert_no_text(caplog.records, _BODY, _NOTE, _QUOTE, _BYOK_KEY)


@pytest.mark.asyncio
async def test_an_empty_pass_settles_refunded_empty_with_its_refund_line(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A well-formed empty answer is refunded: the line says so and stays charged."""
    monkeypatch.setattr(marginalia_service, "generate_response", _ScriptedLLM(_notes()))
    headers, user_id = await _signup(async_client, "settle_empty")
    entry_id = await _create_entry(async_client, headers)
    _capture(caplog)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["no_notes_message"]
    record = _one_settled(caplog)
    assert record.__dict__["outcome"] == "refunded_empty"
    assert record.__dict__["charged"] is True
    assert record.__dict__["bucket"] == BUCKET_MONTHLY
    reasons = await _audit_reasons(db_session, user_id)
    assert reasons[-1] == REASON_REFUND_NO_NOTES
    assert record.__dict__["outcome"] == OUTCOME_FOR_REFUND_REASON[reasons[-1]]
    refunds = records_for(caplog.records, _REFUND_APPLIED)
    assert [r.__dict__["refund_reason"] for r in refunds] == [REASON_REFUND_NO_NOTES]
    _assert_matches_rows(record, await _usage_rows(db_session, user_id))


@pytest.mark.asyncio
async def test_a_corrective_retry_is_one_generation_of_two_attempts(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Retry plus detection: attempts=2, calls=3, every row under one generation_id."""
    scripted = _ScriptedLLM(_notes("never in the entry"), _notes(_QUOTE))
    monkeypatch.setattr(marginalia_service, "generate_response", scripted)
    headers, user_id = await _signup(async_client, "settle_retry")
    await _seed_habit(db_session, user_id)
    entry_id = await _create_entry(async_client, headers)
    _capture(caplog)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    record = _one_settled(caplog)
    extra = record.__dict__
    assert extra["attempts"] == 2
    assert extra["calls"] == 3
    assert extra["outcome"] == "kept"
    assert extra["prompt_tokens"] == 2200
    assert extra["completion_tokens"] == 1050
    rows = await _usage_rows(db_session, user_id)
    assert len(rows) == 3
    assert all(row.charged is True for row in rows)
    _assert_matches_rows(record, rows)
    line = production_line(record)
    assert "attempts=2" in line
    assert "calls=3" in line


@pytest.mark.asyncio
async def test_an_unpriced_model_settles_with_no_cost(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An unknown rate is reported as unknown, never as zero."""
    scripted = _ScriptedLLM(_notes(_QUOTE), model="not-in-pricing-table")
    monkeypatch.setattr(marginalia_service, "generate_response", scripted)
    headers, user_id = await _signup(async_client, "settle_unpriced")
    entry_id = await _create_entry(async_client, headers)
    _capture(caplog)

    await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    record = _one_settled(caplog)
    assert record.__dict__["cost_usd"] is None
    assert "cost_usd=None" in production_line(record)
    _assert_matches_rows(record, await _usage_rows(db_session, user_id))


@pytest.mark.asyncio
async def test_a_failed_server_paid_pass_settles_refunded_failed_with_its_refund(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A provider error after the charge: refunded_failed, charged, refund logged."""
    monkeypatch.setattr(marginalia_service, "generate_response", _raise_provider_error)
    headers, user_id = await _signup(async_client, "settle_failed")
    entry_id = await _create_entry(async_client, headers)
    _capture(caplog)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.BAD_GATEWAY
    record = _one_settled(caplog)
    extra = record.__dict__
    assert extra["feature"] == "resonance"
    assert extra["outcome"] == "refunded_failed"
    assert extra["charged"] is True
    assert extra["bucket"] == BUCKET_MONTHLY
    assert extra["calls"] == 0
    reasons = await _audit_reasons(db_session, user_id)
    assert reasons == [REASON_SPEND_MONTHLY, REASON_REFUND_FAILED_RESONANCE]
    assert extra["outcome"] == OUTCOME_FOR_REFUND_REASON[reasons[-1]]
    refunds = records_for(caplog.records, _REFUND_APPLIED)
    assert [r.__dict__["refund_reason"] for r in refunds] == [REASON_REFUND_FAILED_RESONANCE]


@pytest.mark.asyncio
async def test_a_compensating_refund_whose_commit_fails_is_never_logged(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A failed pass whose compensating refund cannot commit leaves no refund line.

    No refund row is durable, so the stream must not claim one either.
    """
    monkeypatch.setattr(marginalia_service, "generate_response", _raise_provider_error)
    failures = _fail_the_commit_after_the_next_refund(monkeypatch)
    headers, user_id = await _signup(async_client, "settle_compensation_lost")
    entry_id = await _create_entry(async_client, headers)
    _capture(caplog)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.INTERNAL_SERVER_ERROR
    assert failures == []
    assert await _audit_reasons(db_session, user_id) == [REASON_SPEND_MONTHLY]
    assert records_for(caplog.records, _REFUND_APPLIED) == []


@pytest.mark.asyncio
async def test_a_failed_byok_pass_settles_uncharged_without_a_refund(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """BYOK owes no refund: one refunded_failed line with charged=False, nothing else."""
    monkeypatch.setattr(marginalia_service, "generate_response", _raise_provider_error)
    headers, _ = await _signup(async_client, "settle_failed_byok")
    entry_id = await _create_entry(async_client, headers)
    _capture(caplog)

    resp = await async_client.post(
        f"/journal/{entry_id}/resonance", headers={**headers, _BYOK_HEADER: _BYOK_KEY}
    )

    assert resp.status_code == HTTPStatus.BAD_GATEWAY
    record = _one_settled(caplog)
    assert record.__dict__["outcome"] == "refunded_failed"
    assert record.__dict__["charged"] is False
    assert record.__dict__["bucket"] is None
    assert records_for(caplog.records, _REFUND_APPLIED) == []


@pytest.mark.asyncio
async def test_a_care_only_pass_settles_once(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A flagged entry whose pass failed returns care: still exactly one line."""
    monkeypatch.setattr(marginalia_service, "generate_response", _raise_provider_error)
    headers, _ = await _signup(async_client, "settle_care")
    entry_id = await _create_entry(async_client, headers, body=_DISTRESS_BODY)
    _capture(caplog)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["care"] is not None
    record = _one_settled(caplog)
    assert record.__dict__["outcome"] == "refunded_failed"
    assert_no_text(caplog.records, _DISTRESS_BODY)


@pytest.mark.asyncio
async def test_a_pass_withdrawn_under_the_hold_settles_once_with_no_calls(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An entry made intimate while the pass waited: refunded, logged, never dialled."""
    scripted = _ScriptedLLM(_notes(_QUOTE))
    monkeypatch.setattr(marginalia_service, "generate_response", scripted)
    headers, user_id = await _signup(async_client, "settle_withdrawn")
    entry_id = await _create_entry(async_client, headers)
    real_ensure_live = journal_router.ensure_account_live

    async def _made_intimate_while_waiting(session: AsyncSession, owner_id: int) -> None:
        await session.execute(
            update(JournalEntry)
            .where(col(JournalEntry.id) == entry_id)
            .values(classification=JournalClassification.INTIMATE)
        )
        await session.commit()
        await real_ensure_live(session, owner_id)

    monkeypatch.setattr(journal_router, "ensure_account_live", _made_intimate_while_waiting)
    _capture(caplog)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["private"] is True
    record = _one_settled(caplog)
    assert record.__dict__["outcome"] == "refunded_failed"
    assert record.__dict__["calls"] == 0
    assert record.__dict__["attempts"] == 0
    assert await _usage_rows(db_session, user_id) == []


@pytest.mark.asyncio
async def test_a_write_failure_after_a_retried_pass_keeps_its_attempts(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The settle's own failure path reports the pass's real attempts and calls."""
    scripted = _ScriptedLLM(_notes("never in the entry"), _notes(_QUOTE))
    monkeypatch.setattr(marginalia_service, "generate_response", scripted)

    async def _broken_ledger(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("ledger unavailable")

    monkeypatch.setattr(journal_router, "record_llm_usage", _broken_ledger)
    headers, _ = await _signup(async_client, "settle_write_failed")
    entry_id = await _create_entry(async_client, headers)
    _capture(caplog)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.INTERNAL_SERVER_ERROR
    record = _one_settled(caplog)
    assert record.__dict__["outcome"] == "refunded_failed"
    assert record.__dict__["attempts"] == 2
    assert record.__dict__["calls"] == 2
    assert record.__dict__["charged"] is True


@pytest.mark.asyncio
async def test_a_vault_care_escalation_settles_once_as_refunded_failed(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The vault's care guard declined a server-paid pass: refunded, settled, never dialled."""
    monkeypatch.setattr(marginalia_service, "generate_response", _ScriptedLLM(_notes(_QUOTE)))
    vault = ReflectingVaultClient(reflect_error=CreekVaultCareEscalationError())
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    # Only a vault-bound caller's pass is answered by the vault at all (#3061).
    app.dependency_overrides[get_reflection_boundary] = lambda: ReflectionBoundary.VAULT_BOUND
    headers, user_id = await _signup(async_client, "settle_vault_care")
    entry_id = await _create_entry(async_client, headers)
    _capture(caplog)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["care"] is not None
    assert len(vault.reflect_calls) == 1
    record = _one_settled(caplog)
    extra = record.__dict__
    assert extra["feature"] == "resonance"
    assert extra["outcome"] == "refunded_failed"
    assert extra["charged"] is True
    assert extra["bucket"] == BUCKET_MONTHLY
    assert extra["calls"] == 0
    reasons = await _audit_reasons(db_session, user_id)
    assert reasons == [REASON_SPEND_MONTHLY, REASON_REFUND_FAILED_RESONANCE]
    assert extra["outcome"] == OUTCOME_FOR_REFUND_REASON[reasons[-1]]
    refunds = records_for(caplog.records, _REFUND_APPLIED)
    assert [r.__dict__["refund_reason"] for r in refunds] == [REASON_REFUND_FAILED_RESONANCE]
    assert await _usage_rows(db_session, user_id) == []


@pytest.mark.asyncio
async def test_an_empty_pass_whose_write_fails_logs_only_the_refund_that_committed(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The staged no-notes refund is rolled back with the failed write, so it is never logged.

    Only the compensating refund that commits leaves a line: one refund line,
    matching the one refund row the audit trail holds.
    """
    monkeypatch.setattr(marginalia_service, "generate_response", _ScriptedLLM(_notes()))

    async def _broken_ledger(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("ledger unavailable")

    monkeypatch.setattr(journal_router, "record_llm_usage", _broken_ledger)
    headers, user_id = await _signup(async_client, "settle_empty_write_failed")
    entry_id = await _create_entry(async_client, headers)
    _capture(caplog)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.INTERNAL_SERVER_ERROR
    assert _one_settled(caplog).__dict__["outcome"] == "refunded_failed"
    reasons = await _audit_reasons(db_session, user_id)
    assert reasons == [REASON_SPEND_MONTHLY, REASON_REFUND_FAILED_RESONANCE]
    refunds = records_for(caplog.records, _REFUND_APPLIED)
    assert [r.__dict__["refund_reason"] for r in refunds] == reasons[1:]


# --- Essay -----------------------------------------------------------------


class _EssayLLM:
    """Answers the essay dial with fixed text from a priced model."""

    def __init__(self, text: str) -> None:
        self.text = text

    async def __call__(
        self, prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del prompt, history, system_prompt, api_key
        return LLMResponse(
            text=self.text,
            provider="openai",
            model=_MODEL,
            prompt_tokens=800,
            completion_tokens=200,
        )


@dataclass(frozen=True, slots=True)
class _EssayCase:
    """What the provider answers, and how the essay must settle for it."""

    completion: str
    outcome: str
    last_reason: str


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [
        _EssayCase(_LETTER, "kept", REASON_SPEND_MONTHLY),
        _EssayCase("   ", "refused", REASON_REFUND_NO_ESSAY),
    ],
    ids=["kept", "refused"],
)
async def test_an_essay_settles_with_the_outcome_its_audit_reason_names(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    case: _EssayCase,
) -> None:
    """Kept keeps the spend; a non-letter is refunded and settles as refused."""
    monkeypatch.setattr(marginalia_service, "generate_response", _EssayLLM(case.completion))
    headers, user_id = await _signup(async_client, f"essay_{case.outcome}")
    marg_id = await _seed_marginalia(db_session, user_id)
    _capture(caplog)

    resp = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay", headers=headers, json=_PRICED
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    record = _one_settled(caplog)
    extra = record.__dict__
    assert extra["feature"] == "essay"
    assert extra["outcome"] == case.outcome
    assert extra["charged"] is True
    assert extra["bucket"] == BUCKET_MONTHLY
    assert extra["attempts"] == 1
    reasons = await _audit_reasons(db_session, user_id)
    assert reasons[-1] == case.last_reason
    if case.last_reason != REASON_SPEND_MONTHLY:
        assert extra["outcome"] == OUTCOME_FOR_REFUND_REASON[case.last_reason]
    refunds = [r.__dict__["refund_reason"] for r in records_for(caplog.records, _REFUND_APPLIED)]
    assert refunds == [r for r in reasons if r != REASON_SPEND_MONTHLY]
    rows = await _usage_rows(db_session, user_id)
    assert len(rows) == 1
    _assert_matches_rows(record, rows)
    assert f"feature=essay outcome={case.outcome}" in production_line(record)
    assert_no_text(caplog.records, _LETTER, _BODY, _NOTE)


@pytest.mark.asyncio
async def test_a_failed_essay_settles_refunded_failed(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A provider error after the essay's charge: the essay's own refund reason."""
    monkeypatch.setattr(marginalia_service, "generate_response", _raise_provider_error)
    headers, user_id = await _signup(async_client, "essay_failed")
    marg_id = await _seed_marginalia(db_session, user_id)
    _capture(caplog)

    resp = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay", headers=headers, json=_PRICED
    )

    assert resp.status_code == HTTPStatus.BAD_GATEWAY
    record = _one_settled(caplog)
    assert record.__dict__["feature"] == "essay"
    assert record.__dict__["outcome"] == "refunded_failed"
    assert record.__dict__["attempts"] == 1
    reasons = await _audit_reasons(db_session, user_id)
    assert reasons == [REASON_SPEND_MONTHLY, REASON_REFUND_FAILED_ESSAY]
    assert record.__dict__["outcome"] == OUTCOME_FOR_REFUND_REASON[reasons[-1]]
    refunds = records_for(caplog.records, _REFUND_APPLIED)
    assert [r.__dict__["refund_reason"] for r in refunds] == [REASON_REFUND_FAILED_ESSAY]


@pytest.mark.asyncio
async def test_a_refused_essay_whose_commit_fails_logs_only_the_refund_that_committed(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A no-essay refund staged and then lost to a failed commit is never logged.

    The commit that would make the staged refund durable fails; the guard rolls
    it back and compensates instead.
    """
    monkeypatch.setattr(marginalia_service, "generate_response", _EssayLLM("   "))
    failures = _fail_the_commit_after_the_next_refund(monkeypatch)
    headers, user_id = await _signup(async_client, "essay_refused_commit_failed")
    marg_id = await _seed_marginalia(db_session, user_id)
    _capture(caplog)

    resp = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay", headers=headers, json=_PRICED
    )

    assert resp.status_code == HTTPStatus.INTERNAL_SERVER_ERROR
    assert failures == []
    assert _one_settled(caplog).__dict__["outcome"] == "refunded_failed"
    reasons = await _audit_reasons(db_session, user_id)
    assert reasons == [REASON_SPEND_MONTHLY, REASON_REFUND_FAILED_ESSAY]
    refunds = records_for(caplog.records, _REFUND_APPLIED)
    assert [r.__dict__["refund_reason"] for r in refunds] == reasons[1:]


@pytest.mark.asyncio
async def test_a_byok_essay_settles_uncharged_without_a_refund(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The writer's key paid for the letter: charged=False, no refund line."""
    monkeypatch.setattr(marginalia_service, "generate_response", _EssayLLM(_LETTER))
    headers, user_id = await _signup(async_client, "essay_byok")
    marg_id = await _seed_marginalia(db_session, user_id)
    _capture(caplog)

    resp = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay", headers={**headers, _BYOK_HEADER: _BYOK_KEY}
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    record = _one_settled(caplog)
    assert record.__dict__["charged"] is False
    assert record.__dict__["bucket"] is None
    assert record.__dict__["outcome"] == "kept"
    assert records_for(caplog.records, _REFUND_APPLIED) == []
    _assert_matches_rows(record, await _usage_rows(db_session, user_id))


# --- Transcription ---------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("byok", [False, True])
async def test_a_transcription_settles_with_its_tokens_and_cost(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    *,
    byok: bool,
) -> None:
    """One kept transcription line; charged only when the server paid."""
    patch_generate_response(monkeypatch, priced_response(SENTINEL_TEXT))
    headers, user_id = await _signup(async_client, f"transcribe_settle_{byok}")
    if byok:
        headers = {**headers, _BYOK_HEADER: _BYOK_KEY}
    caplog.set_level(logging.INFO, logger="routers.transcription")
    _capture(caplog)

    resp = await async_client.post(
        "/journal/transcribe-page", json=payload(JPEG_BYTES), headers=headers
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    record = _one_settled(caplog)
    extra = record.__dict__
    assert extra["feature"] == "transcription"
    assert extra["outcome"] == "kept"
    assert extra["charged"] is (not byok)
    assert extra["bucket"] == (None if byok else BUCKET_MONTHLY)
    assert extra["attempts"] == 1
    assert extra["prompt_tokens"] == 11
    assert extra["completion_tokens"] == 7
    assert extra["cost_usd"] == format(estimate_cost_usd("gpt-4o-mini", 11, 7), "f")
    rows = await _usage_rows(db_session, user_id)
    assert len(rows) == 1
    _assert_matches_rows(record, rows)
    assert_no_text(caplog.records, SENTINEL_TEXT, b64(JPEG_BYTES), _BYOK_KEY)


# --- Uncharged detection ---------------------------------------------------


@pytest.mark.asyncio
async def test_standalone_detection_is_metered_uncharged_without_a_settlement_line(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The detect route charges nobody: its rows are keyed uncharged, no line."""
    monkeypatch.setattr(marginalia_service, "generate_response", _ScriptedLLM(_notes(_QUOTE)))
    headers, user_id = await _signup(async_client, "detect_uncharged")
    await _seed_habit(db_session, user_id)
    entry_id = await _create_entry(async_client, headers)
    _capture(caplog)

    resp = await async_client.post(f"/journal/{entry_id}/suggestions/detect", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    rows = await _usage_rows(db_session, user_id)
    assert len(rows) == 1
    assert rows[0].charged is False
    assert rows[0].generation_id is not None
    assert records_for(caplog.records, _SETTLED) == []
