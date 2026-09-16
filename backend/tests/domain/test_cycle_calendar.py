"""Per-cycle calendar windows — the anchor a PAST cycle's reviews belong to (#2894).

``begin-again`` used to overwrite the only ``program_started_at`` on record, so
a review written in cycle 1 had no window left to be re-derived from. These
tests pin the resolver that reads the retained anchors back, and — just as
importantly — the four reasons a window can be absent, which the API has to
tell apart rather than collapsing into one silent empty feed.

The clamp is the subtle half. ``program_week_bounds`` derives BOTH bounds from
local midnights; clamping a closed cycle at the raw loop instant would publish
a non-midnight bound and leave the morning of the loop day inside two cycles at
once, which is issue #2886 arriving from the other direction.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from domain.cycle_calendar import (
    CycleAnchorStatus,
    CycleWindow,
    cycle_week_bounds,
    resolve_cycle_window,
)
from domain.program_calendar import program_week_bounds
from models.stage_progress import StageProgress

_PACIFIC = "America/Los_Angeles"

# The anchor every fixture below counts from: a fixed instant, so the assertions
# are arithmetic rather than dependent on when the suite runs.
_CYCLE_ONE_ANCHOR = datetime(2025, 1, 6, 17, 42, tzinfo=UTC)
# 80 days later — deliberately MID-week-12 and at 09:00 local Pacific, not on a
# week boundary and not at midnight. Both matter: if the loop landed on a week
# boundary the raw loop instant and the loop day's local midnight would clamp
# week 12 to the same place, and the clamp assertions below would hold for the
# wrong reason.
_LOOP_INSTANT = datetime(2025, 3, 27, 16, 0, tzinfo=UTC)


def _progress(
    *,
    cycle_number: int,
    program_started_at: datetime = _LOOP_INSTANT,
    past_cycle_anchors: list[str | None] | None = None,
) -> StageProgress:
    """An unpersisted StageProgress carrying just the calendar fields under test."""
    return StageProgress(
        user_id=1,
        current_stage=1,
        completed_stages=[],
        stage_started_at=program_started_at,
        program_started_at=program_started_at,
        cycle_number=cycle_number,
        past_cycle_anchors=past_cycle_anchors,
    )


def test_resolve_cycle_window_for_the_current_cycle_is_open_ended() -> None:
    """The cycle the user is living in ends at no instant — it has not closed."""
    progress = _progress(cycle_number=2, past_cycle_anchors=[_CYCLE_ONE_ANCHOR.isoformat()])

    window, status = resolve_cycle_window(progress, 2)

    assert status is CycleAnchorStatus.RECORDED
    assert window == CycleWindow(cycle_number=2, started_at=_LOOP_INSTANT, ended_at=None)


def test_resolve_cycle_window_for_the_newest_past_cycle_ends_at_the_live_anchor() -> None:
    """Cycle k's end IS cycle k+1's start, which for the newest past cycle is live."""
    progress = _progress(cycle_number=2, past_cycle_anchors=[_CYCLE_ONE_ANCHOR.isoformat()])

    window, status = resolve_cycle_window(progress, 1)

    assert status is CycleAnchorStatus.RECORDED
    assert window == CycleWindow(
        cycle_number=1, started_at=_CYCLE_ONE_ANCHOR, ended_at=_LOOP_INSTANT
    )


def test_resolve_cycle_window_for_an_older_past_cycle_ends_at_its_successors_start() -> None:
    """An older past cycle is bounded by the NEXT retained anchor, not the live one."""
    second = _CYCLE_ONE_ANCHOR + timedelta(days=260)
    progress = _progress(
        cycle_number=3,
        past_cycle_anchors=[_CYCLE_ONE_ANCHOR.isoformat(), second.isoformat()],
    )

    window, status = resolve_cycle_window(progress, 1)

    assert status is CycleAnchorStatus.RECORDED
    assert window == CycleWindow(cycle_number=1, started_at=_CYCLE_ONE_ANCHOR, ended_at=second)


@pytest.mark.parametrize(
    ("cycle_number", "anchors", "cycle"),
    [
        # An anchor destroyed by begin-again before #2894, recorded as unknown.
        (2, [None], 1),
        # A row the backfill has not reached, so no list exists at all.
        (2, None, 1),
        # A list shorter than the cycle count: index out of range, never IndexError.
        (3, [_CYCLE_ONE_ANCHOR.isoformat()], 2),
        # Cycle 0 and below name no cycle at all.
        (2, [_CYCLE_ONE_ANCHOR.isoformat()], 0),
        (2, [_CYCLE_ONE_ANCHOR.isoformat()], -1),
        # Structurally impossible (known values are meant to be a suffix), but the
        # resolver must not LEAN on that: cycle 1's END is unknown, so its window is.
        (3, [_CYCLE_ONE_ANCHOR.isoformat(), None], 1),
        # A corrupt stored string degrades to unknown rather than a 500.
        (2, ["not-a-datetime"], 1),
    ],
)
def test_resolve_cycle_window_reports_an_unrecoverable_anchor_as_unrecorded(
    cycle_number: int, anchors: list[str | None] | None, cycle: int
) -> None:
    """Every way a past cycle's bounds can be unknown reports UNRECORDED, not a guess."""
    progress = _progress(cycle_number=cycle_number, past_cycle_anchors=anchors)

    window, status = resolve_cycle_window(progress, cycle)

    assert window is None
    assert status is CycleAnchorStatus.UNRECORDED


def test_resolve_cycle_window_for_a_cycle_the_user_has_not_reached_is_unstarted() -> None:
    """A future cycle is not unknown — it has not happened, and says so."""
    progress = _progress(cycle_number=2, past_cycle_anchors=[_CYCLE_ONE_ANCHOR.isoformat()])

    window, status = resolve_cycle_window(progress, 9)

    assert window is None
    assert status is CycleAnchorStatus.UNSTARTED


def test_resolve_cycle_window_without_progress_is_no_program() -> None:
    """A caller with no progress row has no calendar at all — a distinct cause."""
    window, status = resolve_cycle_window(None, 1)

    assert window is None
    assert status is CycleAnchorStatus.NO_PROGRAM


def test_cycle_week_bounds_for_an_open_cycle_are_the_program_bounds() -> None:
    """An unclosed cycle windows exactly as the program calendar always did."""
    window = CycleWindow(cycle_number=2, started_at=_LOOP_INSTANT, ended_at=None)

    assert cycle_week_bounds(window, range(1, 2), tz=_PACIFIC) == program_week_bounds(
        _LOOP_INSTANT, range(1, 2), tz=_PACIFIC
    )


def test_cycle_week_bounds_clamp_lands_on_the_loop_days_local_midnight() -> None:
    """A closed cycle ends where its successor's week 1 OPENS — one shared midnight.

    Clamping at the raw loop instant instead would publish a mid-morning bound
    and leave the morning of the loop day inside both cycles at once.
    """
    window = CycleWindow(cycle_number=1, started_at=_CYCLE_ONE_ANCHOR, ended_at=_LOOP_INSTANT)

    unclamped_start, unclamped_end = program_week_bounds(
        _CYCLE_ONE_ANCHOR, range(12, 13), tz=_PACIFIC
    )
    start, clamped_end = cycle_week_bounds(window, range(12, 13), tz=_PACIFIC)
    successor_start, _ = program_week_bounds(_LOOP_INSTANT, range(1, 2), tz=_PACIFIC)

    assert start == unclamped_start
    assert clamped_end == successor_start
    # The loop fell mid-week, so the clamp really moved the bound — and moved it
    # to a midnight, not to the raw instant it happened at.
    assert clamped_end < unclamped_end
    assert clamped_end != _LOOP_INSTANT


def test_cycle_week_bounds_past_the_loop_point_is_empty() -> None:
    """A week the user never reached before looping is an empty window, not a reach-forward."""
    window = CycleWindow(cycle_number=1, started_at=_CYCLE_ONE_ANCHOR, ended_at=_LOOP_INSTANT)

    start, end = cycle_week_bounds(window, range(36, 37), tz=_PACIFIC)

    assert end == start, "a closed cycle must never window past the instant it closed"


def test_cycle_week_bounds_does_not_extend_a_span_that_closes_early() -> None:
    """The clamp only ever pulls the end IN; a fully-elapsed week keeps its own bound."""
    window = CycleWindow(cycle_number=1, started_at=_CYCLE_ONE_ANCHOR, ended_at=_LOOP_INSTANT)

    assert cycle_week_bounds(window, range(1, 2), tz=_PACIFIC) == program_week_bounds(
        _CYCLE_ONE_ANCHOR, range(1, 2), tz=_PACIFIC
    )


def test_resolve_cycle_window_round_trips_a_naive_stored_anchor_as_aware() -> None:
    """SQLite reads tz-aware columns back naive; the window must still be usable.

    ``to_user_date`` refuses naive datetimes, so an un-normalized anchor would
    raise inside the very clamp that is meant to keep the cycles apart.
    """
    progress = _progress(
        cycle_number=2,
        program_started_at=_LOOP_INSTANT.replace(tzinfo=None),
        past_cycle_anchors=[_CYCLE_ONE_ANCHOR.replace(tzinfo=None).isoformat()],
    )

    window, status = resolve_cycle_window(progress, 1)

    assert status is CycleAnchorStatus.RECORDED
    assert window is not None
    assert window.started_at.tzinfo is not None
    assert window.ended_at is not None
    assert window.ended_at.tzinfo is not None
    # And the clamp it feeds does not raise.
    assert cycle_week_bounds(window, range(1, 2), tz=_PACIFIC)[1] > window.started_at
