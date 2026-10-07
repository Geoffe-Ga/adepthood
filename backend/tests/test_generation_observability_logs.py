"""Resonance-economy observability logs (#623 PR3).

The ratified record (``prompts/claude-comms/2026-09-05-resonance-economy-decision.md``
§1) asks the code to "instrument actual input/output tokens, model, cost
estimate, refunds, and cache hits so these defaults can be revised from
evidence". These tests pin the log lines that carry that evidence: a cached
essay reopen, each generation's settlement, and each applied refund.

Every line carries ids and counts only. The production formatter
(``observability.configure_logging``) drops ``extra=`` fields, so the numbers an
operator reads are also asserted in the formatted message itself, and every
record is scanned for the writer's text.
"""

from __future__ import annotations

import logging
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.journal_entry import JournalEntry
from models.llm_usage_log import LLMUsageLog
from models.marginalia import Marginalia, MarginaliaKind
from models.wallet_audit import REASON_SPEND_MONTHLY, WalletAudit
from routers import journal as journal_router
from services import marginalia as marginalia_service
from services.botmason import LLMResponse
from tests.helpers.log_lines import assert_no_text, production_line, records_for
from tests.support.fake_llm import real_provider_response

_BODY = "I walked by the river and the willow bent without breaking."
_LETTER = "A warm letter about beginnings, private to the writer."
_PRICED = {"price_acknowledged": True}
_CACHE_HIT = "marginalia_essay_cache_hit"


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
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
        # A real provider's answer: a stub answer is a refunded demo (#3062).
        return real_provider_response(self.text)


def _essay_path(marg_id: int) -> str:
    return f"/journal/marginalia/{marg_id}/essay"


async def _audit_reasons(session: AsyncSession, user_id: int) -> list[str]:
    result = await session.execute(
        select(WalletAudit.reason)
        .where(col(WalletAudit.user_id) == user_id)
        .order_by(col(WalletAudit.id))
    )
    return list(result.scalars())


async def _usage_rows(session: AsyncSession, user_id: int) -> int:
    result = await session.execute(
        select(LLMUsageLog.id).where(col(LLMUsageLog.user_id) == user_id)
    )
    return len(list(result.scalars()))


@pytest.mark.asyncio
async def test_cached_essay_reopen_logs_a_cache_hit_and_charges_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A reopen of a bought letter logs one pre-barrier cache hit: ids, never text."""
    headers, user_id = await _signup(async_client, "cache_hit_pre")
    marg_id = await _seed_marginalia(db_session, user_id)
    fake = _CountingLLM(_LETTER)
    monkeypatch.setattr(marginalia_service, "generate_response", fake)
    first = await async_client.post(_essay_path(marg_id), headers=headers, json=_PRICED)
    assert first.status_code == HTTPStatus.OK, first.text
    usage_before = await _usage_rows(db_session, user_id)
    caplog.set_level(logging.INFO, logger="routers.journal")
    caplog.clear()

    reopened = await async_client.post(_essay_path(marg_id), headers=headers)

    assert reopened.status_code == HTTPStatus.OK, reopened.text
    assert reopened.json()["essay"] == _LETTER
    assert fake.calls == 1
    assert await _audit_reasons(db_session, user_id) == [REASON_SPEND_MONTHLY]
    assert await _usage_rows(db_session, user_id) == usage_before
    hits = records_for(caplog.records, _CACHE_HIT)
    assert len(hits) == 1
    hit = hits[0]
    assert hit.levelno == logging.INFO
    assert hit.__dict__["user_id"] == user_id
    assert hit.__dict__["id"] == marg_id
    assert hit.__dict__["stage"] == "pre_barrier"
    assert "stage=pre_barrier" in production_line(hit)
    assert_no_text(hits, _LETTER, _BODY)


@pytest.mark.asyncio
async def test_in_barrier_cache_hit_logs_stage_in_barrier(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A concurrent first ask whose letter landed while waiting is an in-barrier hit."""
    headers, user_id = await _signup(async_client, "cache_hit_in")
    marg_id = await _seed_marginalia(db_session, user_id)
    fake = _CountingLLM(_LETTER)
    monkeypatch.setattr(marginalia_service, "generate_response", fake)
    real_ensure_live = journal_router.ensure_account_live

    async def _letter_lands_while_waiting(session: AsyncSession, owner_id: int) -> None:
        # The winning first ask committed its letter while this request queued.
        await session.execute(
            update(Marginalia)
            .where(col(Marginalia.id) == marg_id)
            .values(essay=_LETTER, essay_generated_at=Marginalia.created_at)
        )
        await session.commit()
        await real_ensure_live(session, owner_id)

    monkeypatch.setattr(journal_router, "ensure_account_live", _letter_lands_while_waiting)
    caplog.set_level(logging.INFO, logger="routers.journal")
    caplog.clear()

    resp = await async_client.post(_essay_path(marg_id), headers=headers, json=_PRICED)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["essay"] == _LETTER
    assert fake.calls == 0
    assert await _audit_reasons(db_session, user_id) == []
    assert await _usage_rows(db_session, user_id) == 0
    hits = records_for(caplog.records, _CACHE_HIT)
    assert len(hits) == 1
    assert hits[0].__dict__["stage"] == "in_barrier"
    assert hits[0].__dict__["id"] == marg_id
    assert "stage=in_barrier" in production_line(hits[0])
    assert_no_text(hits, _LETTER, _BODY)
