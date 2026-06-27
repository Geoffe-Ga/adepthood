"""Tests for re-anchoring marginalia on entry edit (journal-resonance-07)."""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from domain.marginalia_anchoring import reanchor_one
from models.journal_entry import JournalEntry
from models.marginalia import Marginalia, MarginaliaKind, MarginaliaStatus

_BODY = "I walked by the river and the willow bent without breaking."
_ANCHOR = "the willow"


def test_fast_path_keeps_offsets_when_unchanged() -> None:
    start = _BODY.index(_ANCHOR)
    out = reanchor_one(_ANCHOR, start, _BODY)
    assert (out.anchor_start, out.anchor_end, out.stale) == (start, start + len(_ANCHOR), False)


def test_insert_before_shifts_offsets_and_stays_active() -> None:
    start = _BODY.index(_ANCHOR)
    new_body = "Yesterday: " + _BODY
    out = reanchor_one(_ANCHOR, start, new_body)
    assert out.stale is False
    assert new_body[out.anchor_start : out.anchor_end] == _ANCHOR
    assert out.anchor_start == new_body.index(_ANCHOR)


def test_deleted_passage_goes_stale() -> None:
    start = _BODY.index(_ANCHOR)
    out = reanchor_one(_ANCHOR, start, "An entirely different entry today.")
    assert out.stale is True


def test_duplicate_text_anchors_to_first_occurrence() -> None:
    new_body = f"{_ANCHOR} ... and again {_ANCHOR}."
    out = reanchor_one(_ANCHOR, 999, new_body)
    assert out.stale is False
    assert out.anchor_start == 0


def test_empty_anchor_text_is_stale() -> None:
    out = reanchor_one("", 5, _BODY)
    assert out.stale is True


async def _signup(client: AsyncClient, username: str = "anchor") -> tuple[dict[str, str], int]:
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


async def _seed(session: AsyncSession, user_id: int) -> tuple[int, int]:
    entry = JournalEntry(sender="user", user_id=user_id, message=_BODY)
    session.add(entry)
    await session.flush()
    start = _BODY.index(_ANCHOR)
    note = Marginalia(
        journal_entry_id=entry.id,
        user_id=user_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=start,
        anchor_end=start + len(_ANCHOR),
        anchor_text=_ANCHOR,
        note="It bends.",
    )
    session.add(note)
    await session.commit()
    await session.refresh(note)
    assert entry.id is not None
    assert note.id is not None
    return entry.id, note.id


@pytest.mark.asyncio
async def test_patch_removing_passage_marks_note_stale(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Editing the body to drop the anchored passage flips the note stale."""
    headers, user_id = await _signup(async_client)
    entry_id, _note_id = await _seed(db_session, user_id)

    resp = await async_client.patch(
        f"/journal/{entry_id}", json={"message": "A completely new page."}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK
    listing = await async_client.get(f"/journal/{entry_id}/marginalia", headers=headers)
    items = listing.json()["items"]
    assert len(items) == 1
    assert items[0]["status"] == MarginaliaStatus.STALE


@pytest.mark.asyncio
async def test_patch_inserting_before_keeps_note_active_with_shifted_span(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Editing elsewhere re-anchors the survivor and keeps it active."""
    headers, user_id = await _signup(async_client, "shift")
    entry_id, _note_id = await _seed(db_session, user_id)
    new_body = "Yesterday: " + _BODY

    resp = await async_client.patch(
        f"/journal/{entry_id}", json={"message": new_body}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK
    items = (await async_client.get(f"/journal/{entry_id}/marginalia", headers=headers)).json()[
        "items"
    ]
    assert items[0]["status"] == MarginaliaStatus.ACTIVE
    assert items[0]["anchor_start"] == new_body.index(_ANCHOR)
