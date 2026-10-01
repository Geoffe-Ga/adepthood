"""The server-paid model guard settles every charged route at net zero (#623).

``generate_response`` refuses Opus/Turbo when the server pays (decision record
§4: "refuse non-cost-bounded models on the server-paid path (no multiplier)").
That refusal is an ``LLMProviderError``, so each charged route's existing
failure arm must hand the writer's unit back: the resonance pass refunds with
``refund_failed_pass``, the essay with ``refund_failed_essay``, and the
transcription rolls its staged spend back. The provider is never dialled.
"""

from __future__ import annotations

from http import HTTPStatus
from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.journal_entry import JournalEntry
from models.marginalia import Marginalia, MarginaliaKind
from models.user import User
from models.wallet_audit import (
    REASON_REFUND_FAILED_ESSAY,
    REASON_REFUND_FAILED_RESONANCE,
    REASON_SPEND_MONTHLY,
    WalletAudit,
)
from services import botmason
from tests.provider_transport import ANTHROPIC_KEY
from tests.transcription_helpers import JPEG_BYTES, payload

_OPUS = "claude-opus-5"
_BODY = "I walked by the river and the willow bent without breaking."


@pytest.fixture
def opus_server(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
    """Configure a server-paid Anthropic deployment pinned to Opus; return the dial mock."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "anthropic")
    monkeypatch.setenv("LLM_API_KEY", ANTHROPIC_KEY)
    monkeypatch.setenv("LLM_MODEL", _OPUS)
    dial = AsyncMock()
    monkeypatch.setattr(botmason, "_call_anthropic", dial)
    return dial


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


async def _seed_entry(session: AsyncSession, user_id: int) -> JournalEntry:
    entry = JournalEntry(sender="user", user_id=user_id, message=_BODY)
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    return entry


async def _seed_note(session: AsyncSession, user_id: int) -> int:
    entry = await _seed_entry(session, user_id)
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


async def _wallet(session: AsyncSession, user_id: int) -> tuple[int, int]:
    await session.rollback()
    session.expire_all()
    user = await session.get(User, user_id)
    assert user is not None
    return user.monthly_messages_used, user.offering_balance


async def _reasons(session: AsyncSession, user_id: int) -> list[str]:
    await session.rollback()
    result = await session.execute(
        select(WalletAudit.reason)
        .where(col(WalletAudit.user_id) == user_id)
        .order_by(col(WalletAudit.id))
    )
    return list(result.scalars())


@pytest.mark.asyncio
async def test_server_paid_opus_resonance_is_502_and_refunded(
    async_client: AsyncClient, db_session: AsyncSession, opus_server: AsyncMock
) -> None:
    """A refused model is a provider failure: 502, unit refunded, nothing dialled."""
    headers, user_id = await _signup(async_client, "opus_pass")
    entry_id = (await _seed_entry(db_session, user_id)).id
    before = await _wallet(db_session, user_id)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.BAD_GATEWAY, resp.text
    assert resp.json()["detail"] == "llm_provider_error"
    assert await _wallet(db_session, user_id) == before
    assert await _reasons(db_session, user_id) == [
        REASON_SPEND_MONTHLY,
        REASON_REFUND_FAILED_RESONANCE,
    ]
    opus_server.assert_not_awaited()


@pytest.mark.asyncio
async def test_server_paid_opus_essay_is_refunded_and_caches_nothing(
    async_client: AsyncClient, db_session: AsyncSession, opus_server: AsyncMock
) -> None:
    """The essay's finally arm refunds the refused letter; the note stays uncached."""
    headers, user_id = await _signup(async_client, "opus_essay")
    note_id = await _seed_note(db_session, user_id)
    before = await _wallet(db_session, user_id)

    resp = await async_client.post(
        f"/journal/marginalia/{note_id}/essay",
        headers=headers,
        json={"price_acknowledged": True},
    )

    assert resp.status_code == HTTPStatus.BAD_GATEWAY, resp.text
    assert await _wallet(db_session, user_id) == before
    assert await _reasons(db_session, user_id) == [
        REASON_SPEND_MONTHLY,
        REASON_REFUND_FAILED_ESSAY,
    ]
    note = await db_session.get(Marginalia, note_id)
    assert note is not None
    assert note.essay is None
    opus_server.assert_not_awaited()


@pytest.mark.asyncio
async def test_server_paid_opus_transcription_is_502_and_leaves_no_audit_row(
    async_client: AsyncClient, db_session: AsyncSession, opus_server: AsyncMock
) -> None:
    """Transcription rolls its staged spend back, so nothing is written at all."""
    headers, user_id = await _signup(async_client, "opus_page")
    before = await _wallet(db_session, user_id)

    resp = await async_client.post(
        "/journal/transcribe-page", headers=headers, json=payload(JPEG_BYTES)
    )

    assert resp.status_code == HTTPStatus.BAD_GATEWAY, resp.text
    assert resp.json()["detail"] == "llm_provider_error"
    assert await _wallet(db_session, user_id) == before
    assert await _reasons(db_session, user_id) == []
    opus_server.assert_not_awaited()
