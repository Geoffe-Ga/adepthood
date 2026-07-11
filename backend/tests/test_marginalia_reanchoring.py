"""Tests for re-anchoring marginalia on entry edit (journal-resonance-07)."""

from __future__ import annotations

from datetime import date
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from domain.marginalia_anchoring import reanchor_one
from models.completion_suggestion import (
    CompletionSuggestion,
    CompletionTargetType,
    SuggestionStatus,
)
from models.goal import Goal
from models.habit import Habit
from models.journal_entry import JournalEntry
from models.marginalia import Marginalia, MarginaliaKind, MarginaliaStatus
from services.marginalia import reanchor_entry_suggestions

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


def test_reanchor_round_trips_with_a_preceding_emoji() -> None:
    """A body with a leading astral (emoji) character still round-trips exactly.

    Python string indexing is code-point-native, so this pins the backend's
    existing correct behavior as a regression guard.
    """
    emoji_body = "\U0001f600" + _BODY
    start = emoji_body.index(_ANCHOR)
    out = reanchor_one(_ANCHOR, start, emoji_body)
    assert out.stale is False
    assert emoji_body[out.anchor_start : out.anchor_end] == _ANCHOR


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


@pytest.mark.asyncio
async def test_stale_note_stays_stale_after_passage_returns(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Once a note goes stale, restoring the original passage does not revive it."""
    headers, user_id = await _signup(async_client, "staleguard")
    entry_id, _note_id = await _seed(db_session, user_id)
    start = _BODY.index(_ANCHOR)

    removed = await async_client.patch(
        f"/journal/{entry_id}", json={"message": "A completely new page."}, headers=headers
    )
    assert removed.status_code == HTTPStatus.OK

    restored = await async_client.patch(
        f"/journal/{entry_id}", json={"message": _BODY}, headers=headers
    )
    assert restored.status_code == HTTPStatus.OK

    listing = await async_client.get(f"/journal/{entry_id}/marginalia", headers=headers)
    items = listing.json()["items"]
    assert len(items) == 1
    assert items[0]["status"] == MarginaliaStatus.STALE
    assert items[0]["anchor_start"] == start
    assert items[0]["anchor_end"] == start + len(_ANCHOR)


async def _seed_entry(session: AsyncSession, user_id: int) -> int:
    entry = JournalEntry(sender="user", user_id=user_id, message=_BODY)
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    assert entry.id is not None
    return entry.id


async def _seed_goal(session: AsyncSession, user_id: int) -> int:
    habit = Habit(
        name="Run",
        icon="running",
        start_date=date(2025, 1, 1),
        energy_cost=1,
        energy_return=2,
        user_id=user_id,
    )
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    goal = Goal(
        habit_id=habit.id,
        title="clear",
        tier="clear",
        target=5.0,
        target_unit="miles",
        frequency=1.0,
        frequency_unit="per_day",
        is_additive=True,
    )
    session.add(goal)
    await session.commit()
    await session.refresh(goal)
    assert goal.id is not None
    return goal.id


async def _seed_suggestion(
    session: AsyncSession,
    *,
    entry_id: int,
    user_id: int,
    goal_id: int,
    status: SuggestionStatus = SuggestionStatus.PENDING,
) -> int:
    start = _BODY.index(_ANCHOR)
    suggestion = CompletionSuggestion(
        journal_entry_id=entry_id,
        user_id=user_id,
        target_type=CompletionTargetType.HABIT,
        goal_id=goal_id,
        user_practice_id=None,
        label="a walk by the willow",
        anchor_start=start,
        anchor_end=start + len(_ANCHOR),
        anchor_text=_ANCHOR,
        status=status,
    )
    session.add(suggestion)
    await session.commit()
    await session.refresh(suggestion)
    assert suggestion.id is not None
    return suggestion.id


@pytest.mark.asyncio
async def test_reanchor_suggestions_dismisses_when_passage_removed(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A pending suggestion auto-dismisses when its anchored passage is deleted."""
    _headers, user_id = await _signup(async_client, "sugdismiss")
    entry_id = await _seed_entry(db_session, user_id)
    entry = await db_session.get(JournalEntry, entry_id)
    assert entry is not None
    goal_id = await _seed_goal(db_session, user_id)
    sug_id = await _seed_suggestion(
        db_session,
        entry_id=entry_id,
        user_id=user_id,
        goal_id=goal_id,
    )

    await reanchor_entry_suggestions(entry, "An entirely different entry today.", db_session)
    await db_session.commit()

    suggestion = await db_session.get(CompletionSuggestion, sug_id)
    assert suggestion is not None
    assert suggestion.status == SuggestionStatus.DISMISSED


@pytest.mark.asyncio
async def test_reanchor_suggestions_shifts_offset_and_stays_pending(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A pending suggestion re-anchors to the shifted offset when the passage moves."""
    _headers, user_id = await _signup(async_client, "sugshift")
    entry_id = await _seed_entry(db_session, user_id)
    entry = await db_session.get(JournalEntry, entry_id)
    assert entry is not None
    goal_id = await _seed_goal(db_session, user_id)
    sug_id = await _seed_suggestion(
        db_session,
        entry_id=entry_id,
        user_id=user_id,
        goal_id=goal_id,
    )
    new_body = "Yesterday: " + _BODY

    await reanchor_entry_suggestions(entry, new_body, db_session)
    await db_session.commit()

    suggestion = await db_session.get(CompletionSuggestion, sug_id)
    assert suggestion is not None
    assert suggestion.status == SuggestionStatus.PENDING
    assert suggestion.anchor_start == new_body.index(_ANCHOR)


@pytest.mark.asyncio
async def test_reanchor_suggestions_leaves_accepted_untouched(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An already-accepted suggestion is left alone even when its passage is removed."""
    _headers, user_id = await _signup(async_client, "sugaccepted")
    entry_id = await _seed_entry(db_session, user_id)
    entry = await db_session.get(JournalEntry, entry_id)
    assert entry is not None
    goal_id = await _seed_goal(db_session, user_id)
    start = _BODY.index(_ANCHOR)
    sug_id = await _seed_suggestion(
        db_session,
        entry_id=entry_id,
        user_id=user_id,
        goal_id=goal_id,
        status=SuggestionStatus.ACCEPTED,
    )

    await reanchor_entry_suggestions(entry, "An entirely different entry today.", db_session)
    await db_session.commit()

    suggestion = await db_session.get(CompletionSuggestion, sug_id)
    assert suggestion is not None
    assert suggestion.status == SuggestionStatus.ACCEPTED
    assert suggestion.anchor_start == start
    assert suggestion.anchor_end == start + len(_ANCHOR)
