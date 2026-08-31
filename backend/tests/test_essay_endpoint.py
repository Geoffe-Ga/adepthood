"""Tests for the lazy essay-expansion endpoint (journal-resonance-06)."""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.journal_entry import JournalEntry
from models.marginalia import Marginalia, MarginaliaKind
from routers import journal as journal_router
from services import botmason as botmason_service
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, LLMResponse

_BODY = "I walked by the river and the willow bent without breaking."


async def _signup(client: AsyncClient, username: str = "essay") -> tuple[dict[str, str], int]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    payload = resp.json()
    return {"Authorization": f"Bearer {payload['token']}"}, int(payload["user_id"])


async def _seed_marginalia(session: AsyncSession, user_id: int) -> int:
    entry = JournalEntry(sender="user", user_id=user_id, message=_BODY)
    session.add(entry)
    await session.flush()
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
    return note.id


class _CountingLLM:
    """Patches the LLM seam, returning fixed text and counting calls."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.calls = 0

    async def __call__(
        self, prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del prompt, history, system_prompt, api_key
        self.calls += 1
        return LLMResponse(
            text=self.text,
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )


@pytest.mark.asyncio
async def test_essay_generates_then_caches(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """First call generates + caches; the second returns it without a new LLM call."""
    headers, user_id = await _signup(async_client)
    marg_id = await _seed_marginalia(db_session, user_id)
    fake = _CountingLLM("A warm letter about beginnings.")
    monkeypatch.setattr(marginalia_service, "generate_response", fake)

    first = await async_client.post(f"/journal/marginalia/{marg_id}/essay", headers=headers)
    assert first.status_code == HTTPStatus.OK
    body = first.json()
    assert body["essay"] == "A warm letter about beginnings."
    assert body["essay_generated_at"] is not None
    assert "user_id" not in body
    assert fake.calls == 1

    second = await async_client.post(f"/journal/marginalia/{marg_id}/essay", headers=headers)
    assert second.status_code == HTTPStatus.OK
    assert second.json()["essay"] == "A warm letter about beginnings."
    assert fake.calls == 1  # cached — no second LLM call


@pytest.mark.asyncio
async def test_essay_other_users_marginalia_is_404(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A user can't expand another user's margin note."""
    _alice_headers, alice_id = await _signup(async_client, "alice_e")
    bob_headers, _bob_id = await _signup(async_client, "bob_e")
    marg_id = await _seed_marginalia(db_session, alice_id)
    monkeypatch.setattr(marginalia_service, "generate_response", _CountingLLM("x"))
    resp = await async_client.post(f"/journal/marginalia/{marg_id}/essay", headers=bob_headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_essay_is_sanitized_and_length_capped(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The stored essay is sanitized and capped to the column limit."""
    headers, user_id = await _signup(async_client, "cap")
    marg_id = await _seed_marginalia(db_session, user_id)
    # Oversized text with an embedded zero-width space.
    monkeypatch.setattr(
        marginalia_service, "generate_response", _CountingLLM("clean\u200bword " + "x" * 20000)
    )
    resp = await async_client.post(f"/journal/marginalia/{marg_id}/essay", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    essay = resp.json()["essay"]
    assert len(essay) <= 10_000
    assert "\u200b" not in essay


def test_essay_is_free_by_default() -> None:
    """The economy seam defaults essay generation to free."""
    assert journal_router.ESSAY_PRICE_UNITS == 0


# --- A permanently exhausted balance is not a transient outage --------------

_BYOK_HEADER = "X-LLM-API-Key"
_BYOK_KEY = "sk-abcdef1234567890abcdef1234567890"  # pragma: allowlist secret
_PROVIDER_PROSE = (
    "Error code: 429 - You exceeded your current quota, please check your plan and billing details."
)


def _refuse_for_credit(monkeypatch: pytest.MonkeyPatch) -> None:
    """Patch the essay LLM seam to refuse the way an empty account does."""

    async def _refuse(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> None:
        del prompt, history, system_prompt, api_key
        raise botmason_service.LLMCreditExhaustedError(_PROVIDER_PROSE, provider="openai")

    monkeypatch.setattr(marginalia_service, "generate_response", _refuse)


async def _assert_no_essay_cached(session: AsyncSession, marg_id: int) -> None:
    """A refused pass leaves the note exactly as it was."""
    note = await session.get(Marginalia, marg_id)
    assert note is not None
    await session.refresh(note)
    assert note.essay is None
    assert note.essay_generated_at is None


@pytest.mark.asyncio
async def test_essay_byok_credit_exhausted_is_402(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The essay path is a second door onto the same provider -- and the same refusal."""
    _refuse_for_credit(monkeypatch)
    headers, user_id = await _signup(async_client, "essay_byok")
    marg_id = await _seed_marginalia(db_session, user_id)

    resp = await async_client.post(
        f"/journal/marginalia/{marg_id}/essay",
        headers={**headers, _BYOK_HEADER: _BYOK_KEY},
    )

    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED, resp.text
    assert resp.json()["detail"] == "llm_credit_exhausted"
    await _assert_no_essay_cached(db_session, marg_id)


@pytest.mark.asyncio
async def test_essay_server_key_credit_exhausted_is_503(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A spent server key on the essay path gets the operator's code, not the reader's."""
    _refuse_for_credit(monkeypatch)
    headers, user_id = await _signup(async_client, "essay_server")
    marg_id = await _seed_marginalia(db_session, user_id)

    resp = await async_client.post(f"/journal/marginalia/{marg_id}/essay", headers=headers)

    assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE, resp.text
    assert resp.json()["detail"] == "llm_service_credit_exhausted"
    await _assert_no_essay_cached(db_session, marg_id)
