"""Tests for the one reconciliation rule between the calendar and the record.

Two things answer "what stage is this person in": ``calendar_stage`` walks
the ratified duration schedule from the program anchor, and
``StageProgress.current_stage`` persists what the person has entered.
``domain.stage_authority`` is the only place that says which is which, so
these tests pin the rule rather than either input.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from domain.constants import STAGE_DURATIONS_DAYS, TOTAL_STAGES
from domain.stage_authority import StageStanding, open_through, stage_standing
from models.stage_progress import StageProgress

_ANCHOR = datetime(2026, 1, 1, tzinfo=UTC)


def _at(days: int) -> datetime:
    """Moment ``days`` after the anchor (mid-day to dodge boundary jitter)."""
    return _ANCHOR + timedelta(days=days, hours=12)


def _progress(current_stage: int) -> StageProgress:
    """A row anchored at ``_ANCHOR`` whose record sits at ``current_stage``."""
    return StageProgress(
        user_id=1,
        current_stage=current_stage,
        completed_stages=list(range(1, current_stage)),
        stage_started_at=_ANCHOR,
        program_started_at=_ANCHOR,
        highest_stage_reached=current_stage,
    )


def test_standing_reports_the_two_answers_separately() -> None:
    """The calendar's offer and the record's entry are named, not averaged."""
    # 60 days in: 21 + 21 elapsed, 18 into the third window.
    standing = stage_standing(_progress(1), _at(60))
    assert standing == StageStanding(offered=3, entered=1)


def test_a_record_that_kept_pace_is_not_lagging() -> None:
    """Entered == offered is the ordinary state, and it is not a gap."""
    standing = stage_standing(_progress(3), _at(60))
    assert standing.is_lagging is False


def test_a_record_left_behind_by_the_calendar_is_lagging() -> None:
    """Two months of silence is the gap the rule exists to describe."""
    assert stage_standing(_progress(1), _at(60)).is_lagging is True


def test_a_record_ahead_of_the_calendar_is_never_lagging() -> None:
    """A legacy row past its window keeps what advancement granted."""
    standing = stage_standing(_progress(5), _at(0))
    assert standing == StageStanding(offered=1, entered=5)
    assert standing.is_lagging is False


def test_the_offer_walks_the_ratified_schedule_not_a_uniform_tiling() -> None:
    """Eight three-week stages then two six-week ones -- ten, non-uniform."""
    first_eight = sum(STAGE_DURATIONS_DAYS[:8])
    assert stage_standing(_progress(1), _at(first_eight)).offered == 9
    assert stage_standing(_progress(1), _at(first_eight + 41)).offered == 9
    assert stage_standing(_progress(1), _at(first_eight + 42)).offered == 10


def test_the_offer_clamps_at_the_end_of_the_curriculum() -> None:
    """Past the 252nd day the calendar offers the last stage, never an 11th."""
    assert stage_standing(_progress(1), _at(10_000)).offered == TOTAL_STAGES


def test_open_through_never_withholds_what_the_calendar_opened() -> None:
    """The load-bearing constraint: a lagging record gates nothing.

    ``NORTH-STAR.md`` line 18 -- nothing is gated behind anything else. A
    record still at stage 1 must not withhold a stage the calendar opened
    two months ago.
    """
    assert open_through(_progress(1), _at(60)) == 3


def test_open_through_never_revokes_what_advancement_granted() -> None:
    """Time can only widen the open set, so an early record still wins."""
    assert open_through(_progress(5), _at(0)) == 5


def test_open_through_of_no_row_is_the_first_stage() -> None:
    """A person with no progress row stands at the beginning, not nowhere."""
    assert open_through(None) == 1
