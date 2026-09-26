"""Tests for re-anchoring marginalia on entry edit (journal-resonance-07)."""

from __future__ import annotations

import logging
from datetime import date
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from domain.marginalia_anchoring import (
    ReanchorResult,
    _changed_window,
    _occurrences,
    reanchor_one,
)
from models.completion_suggestion import (
    CompletionSuggestion,
    CompletionTargetType,
    SuggestionStatus,
)
from models.goal import Goal
from models.habit import Habit
from models.journal_entry import JournalEntry
from models.marginalia import Marginalia, MarginaliaKind, MarginaliaStatus
from models.promoted_quote import PromotedQuote
from services.marginalia import (
    reanchor_entry_marginalia,
    reanchor_entry_promoted_quotes,
    reanchor_entry_suggestions,
)

_BODY = "I walked by the river and the willow bent without breaking."
_ANCHOR = "the willow"


def test_fast_path_keeps_offsets_when_unchanged() -> None:
    start = _BODY.index(_ANCHOR)
    out = reanchor_one(_ANCHOR, start, _BODY, _BODY)
    assert (out.anchor_start, out.anchor_end, out.stale) == (start, start + len(_ANCHOR), False)


def test_insert_before_shifts_offsets_and_stays_active() -> None:
    start = _BODY.index(_ANCHOR)
    new_body = "Yesterday: " + _BODY
    out = reanchor_one(_ANCHOR, start, _BODY, new_body)
    assert out.stale is False
    assert new_body[out.anchor_start : out.anchor_end] == _ANCHOR
    assert out.anchor_start == new_body.index(_ANCHOR)


def test_deleted_passage_goes_stale() -> None:
    start = _BODY.index(_ANCHOR)
    out = reanchor_one(_ANCHOR, start, _BODY, "An entirely different entry today.")
    assert out.stale is True


def test_empty_anchor_text_is_stale() -> None:
    out = reanchor_one("", 5, _BODY, _BODY)
    assert out.stale is True


def test_reanchor_round_trips_with_a_preceding_emoji() -> None:
    """A body with a leading astral (emoji) character still round-trips exactly.

    Python string indexing is code-point-native, so this pins the backend's
    existing correct behavior as a regression guard.
    """
    emoji_body = "\U0001f600" + _BODY
    start = emoji_body.index(_ANCHOR)
    out = reanchor_one(_ANCHOR, start, emoji_body, emoji_body)
    assert out.stale is False
    assert emoji_body[out.anchor_start : out.anchor_end] == _ANCHOR


def test_insert_before_repeated_passage_keeps_anchor_on_its_own_copy() -> None:
    old = f"{_ANCHOR} bent. Later {_ANCHOR} broke."
    start = old.rindex(_ANCHOR)  # the SECOND copy
    new = "Morning: " + old
    out = reanchor_one(_ANCHOR, start, old, new)
    assert out.stale is False
    assert out.anchor_start == start + len("Morning: ") == new.rindex(_ANCHOR)
    assert new[out.anchor_start : out.anchor_end] == _ANCHOR


def test_fast_path_coincidence_on_periodic_text_shifts() -> None:
    """A different copy sliding into the old slot must not be mistaken for the anchor."""
    out = reanchor_one("ab", 3, "ab ab", "xyzab ab")
    assert out == ReanchorResult(6, 8, stale=False)


# Two copies of the passage; the anchor sits on the SECOND one throughout.
_TWO_COPIES = f"First {_ANCHOR} bent. Then {_ANCHOR} broke. After."
_SECOND = _TWO_COPIES.rindex(_ANCHOR)
_SECOND_END = _SECOND + len(_ANCHOR)


@pytest.mark.parametrize(
    "new_body",
    [
        pytest.param(_TWO_COPIES + " And again " + _ANCHOR + ".", id="append-with-new-copy"),
        pytest.param(
            _TWO_COPIES[:_SECOND_END] + " softly" + _TWO_COPIES[_SECOND_END:], id="insert"
        ),
        pytest.param(_TWO_COPIES[: _SECOND_END + 1] + _TWO_COPIES[_SECOND_END + 3 :], id="delete"),
        pytest.param(_TWO_COPIES[:_SECOND_END] + _TWO_COPIES[_SECOND_END:], id="unchanged-body"),
    ],
)
def test_edit_strictly_after_anchor_keeps_offsets(new_body: str) -> None:
    out = reanchor_one(_ANCHOR, _SECOND, _TWO_COPIES, new_body)
    assert out == ReanchorResult(_SECOND, _SECOND_END, stale=False)
    assert new_body[out.anchor_start : out.anchor_end] == _ANCHOR


def test_edit_between_copies_after_first_anchor_keeps_it() -> None:
    """An edit between the anchored first copy and a later copy leaves it in place."""
    first = _TWO_COPIES.index(_ANCHOR)
    cut = first + len(_ANCHOR) + 1
    new_body = _TWO_COPIES[:cut] + "and swayed, " + _TWO_COPIES[cut:]
    out = reanchor_one(_ANCHOR, first, _TWO_COPIES, new_body)
    assert out == ReanchorResult(first, first + len(_ANCHOR), stale=False)


@pytest.mark.parametrize(
    "new_body",
    [
        pytest.param("Morning: " + _TWO_COPIES, id="insert-at-start"),
        pytest.param(
            _TWO_COPIES[: _SECOND - 1] + " quietly" + _TWO_COPIES[_SECOND - 1 :],
            id="insert-between",
        ),
        pytest.param(_TWO_COPIES[len("First ") :], id="delete-at-start"),
        pytest.param(_TWO_COPIES[: _SECOND - 6] + _TWO_COPIES[_SECOND - 1 :], id="delete-between"),
        pytest.param("1st" + _TWO_COPIES[len("First") :], id="replace-before"),
    ],
)
def test_edit_strictly_before_anchor_shifts_by_net_delta(new_body: str) -> None:
    delta = len(new_body) - len(_TWO_COPIES)
    out = reanchor_one(_ANCHOR, _SECOND, _TWO_COPIES, new_body)
    assert out == ReanchorResult(_SECOND + delta, _SECOND_END + delta, stale=False)
    assert new_body[out.anchor_start : out.anchor_end] == _ANCHOR


def test_boundary_insert_at_anchor_start_shifts() -> None:
    """An insertion exactly at ``anchor_start`` counts as before the anchor."""
    new_body = _TWO_COPIES[:_SECOND] + "% " + _TWO_COPIES[_SECOND:]
    out = reanchor_one(_ANCHOR, _SECOND, _TWO_COPIES, new_body)
    assert out == ReanchorResult(_SECOND + 2, _SECOND_END + 2, stale=False)


def test_boundary_insert_at_anchor_end_keeps() -> None:
    """An insertion exactly at ``anchor_end`` counts as after the anchor."""
    new_body = _TWO_COPIES[:_SECOND_END] + " %" + _TWO_COPIES[_SECOND_END:]
    out = reanchor_one(_ANCHOR, _SECOND, _TWO_COPIES, new_body)
    assert out == ReanchorResult(_SECOND, _SECOND_END, stale=False)


def test_overlapping_edit_unique_survivor_reanchors() -> None:
    """An edit whose window lands inside a unique passage re-finds its one copy.

    Typing a stray "the " before "the willow" is diffed prefix-greedily, so the
    changed window sits inside the old anchor; the passage is still unique in
    both bodies, so relocating to it is not a guess.
    """
    start = _BODY.index(_ANCHOR)
    new_body = _BODY.replace("and the willow", "and the the willow")
    out = reanchor_one(_ANCHOR, start, _BODY, new_body)
    assert out.stale is False
    assert out.anchor_start == new_body.index(_ANCHOR)
    assert new_body[out.anchor_start : out.anchor_end] == _ANCHOR


def test_overlapping_edit_destroying_own_copy_with_sibling_goes_stale() -> None:
    """Exactly one copy survives, but it is a sibling: never move there (AC7 over AC5)."""
    new_body = _TWO_COPIES[:_SECOND] + "the oak" + _TWO_COPIES[_SECOND_END:]
    assert new_body.count(_ANCHOR) == 1
    out = reanchor_one(_ANCHOR, _SECOND, _TWO_COPIES, new_body)
    assert out == ReanchorResult(_SECOND, _SECOND_END, stale=True)


@pytest.mark.parametrize(
    "old",
    [
        pytest.param(f"X{_ANCHOR}Y|{_ANCHOR}", id="two-copies-in-old"),
        pytest.param(f"X{_ANCHOR}Y|", id="unique-in-old"),
    ],
)
def test_overlapping_edit_with_two_new_occurrences_goes_stale(old: str) -> None:
    """Two copies in the new body after an edit that hit the anchor: never pick one.

    The unique-in-old case matters on its own: the passage was unambiguous
    before the edit, but the edit made two, so relocating would still guess.
    """
    new = f"{_ANCHOR}|{_ANCHOR}"
    out = reanchor_one(_ANCHOR, 1, old, new)
    assert out == ReanchorResult(1, 1 + len(_ANCHOR), stale=True)


def test_drifted_offsets_with_two_new_occurrences_go_stale() -> None:
    """Offsets that no longer spell a unique passage cannot pick between two new copies."""
    out = reanchor_one(_ANCHOR, 999, _BODY, f"{_BODY} Again {_ANCHOR}.")
    assert out == ReanchorResult(999, 999 + len(_ANCHOR), stale=True)


@pytest.mark.parametrize("start", [999, -5])
def test_out_of_range_start_does_not_raise(start: int) -> None:
    """Offsets that do not spell the text relocate only to a passage unique in both bodies."""
    new_body = "Yesterday: " + _BODY
    unique = reanchor_one(_ANCHOR, start, _BODY, new_body)
    assert unique == ReanchorResult(
        new_body.index(_ANCHOR), new_body.index(_ANCHOR) + len(_ANCHOR), stale=False
    )
    ambiguous = reanchor_one(_ANCHOR, start, _TWO_COPIES, "Morning: " + _TWO_COPIES)
    assert ambiguous == ReanchorResult(start, start + len(_ANCHOR), stale=True)


def test_passage_absent_from_old_body_goes_stale() -> None:
    """Without a unique copy in the OLD body there is nothing to prove identity against."""
    out = reanchor_one(_ANCHOR, 0, "no passage here", f"{_ANCHOR} arrives")
    assert out == ReanchorResult(0, len(_ANCHOR), stale=True)


def test_occurrences_counts_overlapping_matches() -> None:
    assert _occurrences("aa", "aaa", 3) == [0, 1]


def test_occurrences_stops_at_limit() -> None:
    assert _occurrences("a", "aaaa", 2) == [0, 1]
    assert _occurrences("a", "aaaa", 3) == [0, 1, 2]
    assert _occurrences("z", "aaaa", 2) == []


def test_changed_window_bounds_suffix_by_shorter_body() -> None:
    """Periodic text must not let prefix and suffix overlap."""
    assert _changed_window("ab ab", "xyzab ab") == (0, 0, 3)
    assert _changed_window("aaa", "aaaa") == (3, 3, 1)
    assert _changed_window("same", "same") == (4, 4, 0)


# --- Property: a repeated passage never jumps to a different copy -----------

# Filler and edit characters are disjoint from the passage, so the prefix/suffix
# window of every generated edit is exactly the edit (no greedy ambiguity).
_INSERTED = "%%%"
_REPLACEMENT = "%"
_MAX_EDIT_LEN = 3
_COPY_COUNTS = (2, 3)
# The enumeration yields ~1000 cases; a floor guards against it silently shrinking.
_MIN_PROPERTY_CASES = 900


def _repeated_body(copies: int) -> str:
    return "<" + "|".join([_ANCHOR] * copies) + ">"


def _edits(old: str) -> list[tuple[int, int, str]]:
    """Every insert / replace / delete ``(i, j, text)`` over ``old`` (old[i:j] -> text)."""
    edits = [(i, i, _INSERTED) for i in range(len(old) + 1)]
    for length in range(1, _MAX_EDIT_LEN + 1):
        for i in range(len(old) - length + 1):
            j = i + length
            edits.append((i, j, _REPLACEMENT))
            # Deleting old[i:j] when old[i] == old[j] is the documented
            # prefix-greedy ambiguity: the diff cannot tell which run went.
            if j == len(old) or old[i] != old[j]:
                edits.append((i, j, ""))
    return edits


def _expected(start: int, end: int, edit: tuple[int, int, str], delta: int) -> ReanchorResult:
    i, j, _text = edit
    touched = (i < end and j > start) if j > i else (start < i < end)
    if touched:
        return ReanchorResult(start, end, stale=True)
    exp = start if i >= end else start + delta
    return ReanchorResult(exp, exp + len(_ANCHOR), stale=False)


def test_repeated_passage_never_jumps_copies() -> None:
    """Keyed on expected position, not copy index: a destroyed sibling renumbers copies."""
    failures: list[str] = []
    cases = 0
    for copies in _COPY_COUNTS:
        old = _repeated_body(copies)
        starts = [1 + n * (len(_ANCHOR) + 1) for n in range(copies)]
        for start in starts:
            end = start + len(_ANCHOR)
            for edit in _edits(old):
                i, j, text = edit
                new = old[:i] + text + old[j:]
                want = _expected(start, end, edit, len(new) - len(old))
                got = reanchor_one(_ANCHOR, start, old, new)
                cases += 1
                spelled = got.stale or new[got.anchor_start : got.anchor_end] == _ANCHOR
                if got != want or not spelled:
                    failures.append(f"k={copies} start={start} edit={edit}: {got} != {want}")
    assert cases >= _MIN_PROPERTY_CASES
    assert failures == [], "\n".join(failures[:20])


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


async def _seed(
    session: AsyncSession,
    user_id: int,
    *,
    message: str = _BODY,
    anchor_start: int | None = None,
) -> tuple[int, int]:
    entry = JournalEntry(sender="user", user_id=user_id, message=message)
    session.add(entry)
    await session.flush()
    start = message.index(_ANCHOR) if anchor_start is None else anchor_start
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


async def _seed_entry(session: AsyncSession, user_id: int, *, message: str = _BODY) -> int:
    entry = JournalEntry(sender="user", user_id=user_id, message=message)
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

    await reanchor_entry_suggestions(
        entry,
        db_session,
        old_message=_BODY,
        new_message="An entirely different entry today.",
    )
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

    await reanchor_entry_suggestions(entry, db_session, old_message=_BODY, new_message=new_body)
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

    await reanchor_entry_suggestions(
        entry,
        db_session,
        old_message=_BODY,
        new_message="An entirely different entry today.",
    )
    await db_session.commit()

    suggestion = await db_session.get(CompletionSuggestion, sug_id)
    assert suggestion is not None
    assert suggestion.status == SuggestionStatus.ACCEPTED
    assert suggestion.anchor_start == start
    assert suggestion.anchor_end == start + len(_ANCHOR)


# --- PATCH-level: the router threads the OLD body to every re-anchor path ----


async def _seed_second_copy_note_and_suggestion(
    session: AsyncSession, user_id: int
) -> tuple[int, int, int]:
    """Seed a two-copy entry with a note AND a pending suggestion on the second copy."""
    entry_id, note_id = await _seed(session, user_id, message=_TWO_COPIES, anchor_start=_SECOND)
    goal_id = await _seed_goal(session, user_id)
    sug_id = await _seed_suggestion(session, entry_id=entry_id, user_id=user_id, goal_id=goal_id)
    suggestion = await session.get(CompletionSuggestion, sug_id)
    assert suggestion is not None
    suggestion.anchor_start = _SECOND
    suggestion.anchor_end = _SECOND_END
    await session.commit()
    return entry_id, note_id, sug_id


@pytest.mark.asyncio
async def test_patch_insert_before_repeated_passage_keeps_note_on_its_own_copy(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client, "twocopynote")
    entry_id, _note_id, _sug_id = await _seed_second_copy_note_and_suggestion(db_session, user_id)
    new_body = "Morning: " + _TWO_COPIES

    resp = await async_client.patch(
        f"/journal/{entry_id}", json={"message": new_body}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK
    items = (await async_client.get(f"/journal/{entry_id}/marginalia", headers=headers)).json()[
        "items"
    ]
    assert items[0]["status"] == MarginaliaStatus.ACTIVE
    assert items[0]["anchor_start"] == _SECOND + len("Morning: ")
    assert new_body[items[0]["anchor_start"] : items[0]["anchor_end"]] == _ANCHOR


@pytest.mark.asyncio
async def test_patch_insert_before_repeated_passage_keeps_suggestion_pending_on_its_own_copy(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Through the router, not a direct service call: the suggestion path gets the old body."""
    headers, user_id = await _signup(async_client, "twocopysug")
    entry_id, _note_id, sug_id = await _seed_second_copy_note_and_suggestion(db_session, user_id)
    new_body = "Morning: " + _TWO_COPIES

    resp = await async_client.patch(
        f"/journal/{entry_id}", json={"message": new_body}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK
    db_session.expire_all()
    suggestion = await db_session.get(CompletionSuggestion, sug_id)
    assert suggestion is not None
    assert suggestion.status == SuggestionStatus.PENDING
    assert suggestion.anchor_start == _SECOND + len("Morning: ")
    assert suggestion.anchor_end == suggestion.anchor_start + len(_ANCHOR)


@pytest.mark.asyncio
async def test_patch_editing_anchored_copy_with_siblings_goes_stale_and_dismissed(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Rewriting the anchored copy leaves a sibling; neither row may move onto it."""
    headers, user_id = await _signup(async_client, "twocopyedit")
    entry_id, note_id, sug_id = await _seed_second_copy_note_and_suggestion(db_session, user_id)
    new_body = _TWO_COPIES[:_SECOND] + "the oak" + _TWO_COPIES[_SECOND_END:]

    resp = await async_client.patch(
        f"/journal/{entry_id}", json={"message": new_body}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK
    db_session.expire_all()
    note = await db_session.get(Marginalia, note_id)
    suggestion = await db_session.get(CompletionSuggestion, sug_id)
    assert note is not None
    assert suggestion is not None
    assert (note.status, note.anchor_start, note.anchor_end) == (
        MarginaliaStatus.STALE,
        _SECOND,
        _SECOND_END,
    )
    assert (suggestion.status, suggestion.anchor_start, suggestion.anchor_end) == (
        SuggestionStatus.DISMISSED,
        _SECOND,
        _SECOND_END,
    )


@pytest.mark.asyncio
async def test_reanchor_services_emit_no_body_or_anchor_logs(
    async_client: AsyncClient, db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    """Privacy: re-anchoring logs neither the anchored passage nor the body text."""
    _headers, user_id = await _signup(async_client, "quietanchor")
    entry_id, _note_id, _sug_id = await _seed_second_copy_note_and_suggestion(db_session, user_id)
    entry = await db_session.get(JournalEntry, entry_id)
    assert entry is not None
    db_session.add(
        PromotedQuote(
            user_id=user_id,
            source_entry_id=entry_id,
            anchor_text=_ANCHOR,
            anchor_start=_SECOND,
            anchor_end=_SECOND_END,
        )
    )
    await db_session.commit()
    edits = (
        "Morning: " + _TWO_COPIES,  # insert before: shifts
        _TWO_COPIES[:_SECOND] + "the oak" + _TWO_COPIES[_SECOND_END:],  # ambiguous: stale
    )
    distinctive = "bent. Then"

    caplog.set_level(logging.DEBUG)
    for new_body in edits:
        for service in (
            reanchor_entry_marginalia,
            reanchor_entry_suggestions,
            reanchor_entry_promoted_quotes,
        ):
            await service(entry, db_session, old_message=_TWO_COPIES, new_message=new_body)

    for record in caplog.records:
        rendered = " ".join(
            [record.getMessage(), repr(record.args), *map(repr, vars(record).values())]
        )
        assert _ANCHOR not in rendered
        assert distinctive not in rendered
    assert _ANCHOR not in caplog.text
    assert distinctive not in caplog.text
