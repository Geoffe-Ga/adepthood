"""Stub output stored before #3096 is never served outside the test seam.

Before the payer gate, a ``stub`` deployment cached demo letters into
``Marginalia.essay`` and stored notes the stub wrote, each stamped with the B07
provenance ``demo`` (#3062). Stopping new stub output is not enough: those rows
would keep reaching writers. Outside the armed seam they are treated as absent
-- not listed, not returned as a cached letter, not counted as one, and never
sent along as a prior letter -- so a demo letter is regenerated through the
payer gate or refused by it. Nothing is deleted: hiding is reversible.

Inside the armed seam (the backend suite, the e2e lane) demo rows stay visible,
because there they are the only output the stub can give.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from http import HTTPStatus
from typing import TYPE_CHECKING, Final

import pytest

from models.marginalia import Marginalia, MarginaliaKind, MarginaliaSource
from routers.journal import _prior_letter_essays
from services import botmason
from tests.incident.test_privacy_suspension import seed_entry, signup
from tests.provider_transport import ANTHROPIC_KEY, use_anthropic

if TYPE_CHECKING:
    from httpx import AsyncClient
    from sqlalchemy.ext.asyncio import AsyncSession

_DEMO_LETTER: Final = 'BotMason hears you. You said: "a canned letter" — demo.'
_REAL_LETTER: Final = "A letter a real model wrote."
_DEMO: Final = MarginaliaSource.DEMO.value
_REAL: Final = MarginaliaSource.APP_PROVIDER.value
_GENERATED_AT: Final = datetime(2026, 9, 1, 9, 0, tzinfo=UTC)
_ANTHROPIC_LETTER: Final[dict[str, object]] = {
    "id": "msg_1",
    "type": "message",
    "role": "assistant",
    "model": "claude-sonnet-5",
    "content": [
        {
            "type": "text",
            "text": (
                "Dear writer, the river you named keeps moving, and so do you. "
                "What bends need not break; let the willow teach the rest."
            ),
        }
    ],
    "stop_reason": "end_turn",
    "stop_sequence": None,
    "usage": {"input_tokens": 1, "output_tokens": 1},
}


def run_as_deployed(monkeypatch: pytest.MonkeyPatch) -> None:
    """A real deployment: the default ``stub`` provider and no seam."""
    monkeypatch.delenv(botmason.STUB_SEAM_ENV_VAR, raising=False)
    monkeypatch.setenv("BOTMASON_PROVIDER", "stub")
    monkeypatch.delenv("LLM_API_KEY", raising=False)


@dataclass(frozen=True)
class Stored:
    """What a pre-#3096 row carried: its note's source, and its cached letter if any."""

    source: str
    essay: str | None = None
    essay_source: str | None = None
    anchor: tuple[int, int] = (0, 6)


async def seed_note(session: AsyncSession, user_id: int, entry_id: int, stored: Stored) -> int:
    """One stamped note on ``entry_id``, with its letter cached when ``stored.essay`` is set."""
    note = Marginalia(
        journal_entry_id=entry_id,
        user_id=user_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=stored.anchor[0],
        anchor_end=stored.anchor[1],
        anchor_text="I medi",
        note="A note.",
        source=stored.source,
        receipt_version=1,
        essay=stored.essay,
        essay_generated_at=None if stored.essay is None else _GENERATED_AT,
        essay_source=stored.essay_source,
    )
    session.add(note)
    await session.commit()
    await session.refresh(note)
    assert note.id is not None
    return note.id


@pytest.mark.asyncio
async def test_a_cached_demo_letter_is_not_served_and_the_gate_answers(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A demo letter is no cached letter: a keyless writer on a stub server gets the 402."""
    run_as_deployed(monkeypatch)
    headers, user_id, _ = await signup(async_client, "demo_letter_refused")
    entry_id = await seed_entry(db_session, user_id)
    note_id = await seed_note(db_session, user_id, entry_id, Stored(_REAL, _DEMO_LETTER, _DEMO))

    resp = await async_client.post(
        f"/journal/marginalia/{note_id}/essay", headers=headers, json={"price_acknowledged": True}
    )

    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED, resp.text
    assert _DEMO_LETTER not in resp.text


@pytest.mark.asyncio
async def test_a_cached_demo_letter_is_regenerated_for_a_payer(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With a personal key, the demo letter is replaced by a real one, not reopened."""
    transport = use_anthropic(monkeypatch, HTTPStatus.OK, _ANTHROPIC_LETTER)
    run_as_deployed(monkeypatch)
    headers, user_id, _ = await signup(async_client, "demo_letter_regenerated")
    entry_id = await seed_entry(db_session, user_id)
    note_id = await seed_note(db_session, user_id, entry_id, Stored(_REAL, _DEMO_LETTER, _DEMO))

    resp = await async_client.post(
        f"/journal/marginalia/{note_id}/essay",
        headers={**headers, "X-LLM-API-Key": ANTHROPIC_KEY},
        json={"price_acknowledged": True},
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert transport.request_count >= 1
    assert resp.json()["essay"] != _DEMO_LETTER
    assert resp.json()["essay_source"] != _DEMO


@pytest.mark.asyncio
async def test_listing_hides_demo_notes_and_demo_letters(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A demo note is not listed; a real note keeps its place but loses its demo letter."""
    run_as_deployed(monkeypatch)
    headers, user_id, _ = await signup(async_client, "demo_listing")
    entry_id = await seed_entry(db_session, user_id)
    demo_note = await seed_note(db_session, user_id, entry_id, Stored(_DEMO))
    real_note = await seed_note(
        db_session, user_id, entry_id, Stored(_REAL, _DEMO_LETTER, _DEMO, anchor=(7, 12))
    )

    resp = await async_client.get(f"/journal/{entry_id}/marginalia", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    items = resp.json()["items"]
    assert [item["id"] for item in items] == [real_note]
    assert demo_note not in {item["id"] for item in items}
    assert items[0]["essay"] is None
    assert items[0]["essay_generated_at"] is None
    assert items[0]["essay_source"] is None


@pytest.mark.asyncio
async def test_voice_drafts_and_prior_letters_skip_demo_letters(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The shelf lists only real letters, and only real letters ride along as context."""
    run_as_deployed(monkeypatch)
    headers, user_id, _ = await signup(async_client, "demo_drafts")
    demo_entry = await seed_entry(db_session, user_id)
    real_entry = await seed_entry(db_session, user_id)
    other_entry = await seed_entry(db_session, user_id)
    await seed_note(db_session, user_id, demo_entry, Stored(_REAL, _DEMO_LETTER, _DEMO))
    real_note = await seed_note(db_session, user_id, real_entry, Stored(_REAL, _REAL_LETTER, _REAL))

    shelf = await async_client.get("/journal/voice-drafts", headers=headers)
    prior = await _prior_letter_essays(db_session, user_id=user_id, exclude_entry_id=other_entry)

    assert shelf.status_code == HTTPStatus.OK, shelf.text
    assert [item["marginalia_id"] for item in shelf.json()["items"]] == [real_note]
    assert shelf.json()["total"] == 1
    assert prior == [_REAL_LETTER]


@pytest.mark.asyncio
async def test_inside_the_armed_seam_demo_rows_stay_visible(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Control: the suite and the e2e lane keep seeing the stub's own output."""
    assert botmason.stub_seam_armed()
    headers, user_id, _ = await signup(async_client, "demo_seam")
    entry_id = await seed_entry(db_session, user_id)
    note_id = await seed_note(db_session, user_id, entry_id, Stored(_DEMO, _DEMO_LETTER, _DEMO))

    listing = await async_client.get(f"/journal/{entry_id}/marginalia", headers=headers)
    shelf = await async_client.get("/journal/voice-drafts", headers=headers)

    assert [item["id"] for item in listing.json()["items"]] == [note_id]
    assert listing.json()["items"][0]["essay"] == _DEMO_LETTER
    assert [item["marginalia_id"] for item in shelf.json()["items"]] == [note_id]
