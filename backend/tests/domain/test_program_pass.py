"""``close_pass`` measures how far a pass got from the pass's OWN start (issue #3723).

A pass is closed with the last day it ran; the stage and week it reached and
whether it ran to the end of stage 10 come from its ``started_on`` alone, never
from the live anchor, so a later begin-again cannot move an earlier pass.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from domain.constants import DAYS_PER_WEEK, STAGE_DURATIONS_DAYS, TOTAL_PROGRAM_DAYS, TOTAL_STAGES
from domain.program_pass import PROGRAM_CALENDAR, PassCalendar, close_pass
from domain.weekly_prompts import TOTAL_WEEKS
from models.program_pass import PassOrigin, ProgramPass

_STARTED_ON = date(2026, 1, 5)


def _live_pass(started_on: date = _STARTED_ON) -> ProgramPass:
    """A live pass: no end, nothing reached yet."""
    return ProgramPass(
        user_id=1,
        pass_number=1,
        started_on=started_on,
        origin=PassOrigin.FIRST_RUN,
    )


def _closed_after(elapsed_days: int) -> ProgramPass:
    """A pass closed ``elapsed_days`` after it started (0 = closed on its first day)."""
    pass_ = _live_pass()
    return close_pass(
        pass_, ended_on=_STARTED_ON + timedelta(days=elapsed_days), calendar=PROGRAM_CALENDAR
    )


def test_the_issue_example_reaches_stage_seven_week_twenty_one() -> None:
    """2026-01-05 → 2026-05-31: 146 elapsed days, week 21, stage 7, partial."""
    closed = close_pass(_live_pass(), ended_on=date(2026, 5, 31), calendar=PROGRAM_CALENDAR)

    assert closed.ended_on == date(2026, 5, 31)
    assert closed.reached_week == 21
    assert closed.reached_stage == 7
    assert closed.completed is False


def test_closing_mutates_and_returns_the_same_pass() -> None:
    """The caller's row is the one updated, so the session tracks the write."""
    pass_ = _live_pass()

    assert close_pass(pass_, ended_on=_STARTED_ON, calendar=PROGRAM_CALENDAR) is pass_


@pytest.mark.parametrize(
    ("elapsed", "stage", "week"),
    [
        pytest.param(0, 1, 1, id="first-day"),
        pytest.param(STAGE_DURATIONS_DAYS[0] - 1, 1, 3, id="last-day-of-stage-1"),
        pytest.param(STAGE_DURATIONS_DAYS[0], 2, 4, id="first-day-of-stage-2"),
        pytest.param(sum(STAGE_DURATIONS_DAYS[:8]), 9, 25, id="first-day-of-stage-9"),
        pytest.param(sum(STAGE_DURATIONS_DAYS[:9]), 10, 31, id="first-day-of-stage-10"),
    ],
)
def test_a_pass_closed_at_a_stage_boundary(elapsed: int, stage: int, week: int) -> None:
    """Stage and week flip exactly where the schedule opens the next window."""
    closed = _closed_after(elapsed)

    assert (closed.reached_stage, closed.reached_week, closed.completed) == (stage, week, False)


def test_a_pass_closed_mid_stage() -> None:
    """Ten days into stage 4 (day 73) is stage 4, week 11, and only partial."""
    elapsed = sum(STAGE_DURATIONS_DAYS[:3]) + 10

    closed = _closed_after(elapsed)

    assert closed.reached_stage == 4
    assert closed.reached_week == elapsed // DAYS_PER_WEEK + 1
    assert closed.completed is False


def test_a_pass_closed_exactly_at_the_end_of_stage_ten_is_complete() -> None:
    """The final program day is the last day of stage 10: stage 10, week 36, complete."""
    closed = _closed_after(TOTAL_PROGRAM_DAYS - 1)

    assert closed.reached_stage == TOTAL_STAGES
    assert closed.reached_week == TOTAL_WEEKS
    assert closed.completed is True


def test_a_pass_closed_one_day_short_of_the_end_is_partial() -> None:
    """A day short of the end of stage 10 is a partial completion, not a full one."""
    closed = _closed_after(TOTAL_PROGRAM_DAYS - 2)

    assert closed.reached_stage == TOTAL_STAGES
    assert closed.reached_week == TOTAL_WEEKS
    assert closed.completed is False


def test_a_pass_that_ran_past_the_end_clamps_to_the_last_stage_and_week() -> None:
    """Days after the program's end add nothing: stage 10, week 36, complete."""
    closed = _closed_after(TOTAL_PROGRAM_DAYS + 90)

    assert (closed.reached_stage, closed.reached_week, closed.completed) == (
        TOTAL_STAGES,
        TOTAL_WEEKS,
        True,
    )


def test_a_pass_left_on_the_day_it_began_reached_the_first_day_only() -> None:
    """Begin-again on a pass's first day ends it the day BEFORE it began.

    The end is still recorded as the day before the next pass, so passes never
    overlap; the pass ran zero days and is measured as the first day of stage 1.
    """
    closed = close_pass(
        _live_pass(), ended_on=_STARTED_ON - timedelta(days=1), calendar=PROGRAM_CALENDAR
    )

    assert closed.ended_on == _STARTED_ON - timedelta(days=1)
    assert (closed.reached_stage, closed.reached_week, closed.completed) == (1, 1, False)


def test_the_calendar_is_the_measure_not_the_module_schedule() -> None:
    """A two-stage, two-week calendar measures the same pass differently."""
    short = PassCalendar(stage_durations_days=(7, 7))

    halfway = close_pass(_live_pass(), ended_on=_STARTED_ON + timedelta(days=7), calendar=short)
    finished = close_pass(_live_pass(), ended_on=_STARTED_ON + timedelta(days=13), calendar=short)

    assert (halfway.reached_stage, halfway.reached_week, halfway.completed) == (2, 2, False)
    assert (finished.reached_stage, finished.reached_week, finished.completed) == (2, 2, True)


def test_the_program_calendar_is_the_shipped_schedule() -> None:
    """The default measure is the curriculum's own 36-week, ten-stage schedule."""
    assert PROGRAM_CALENDAR.stage_durations_days == STAGE_DURATIONS_DAYS
    assert PROGRAM_CALENDAR.total_days == TOTAL_PROGRAM_DAYS
    assert PROGRAM_CALENDAR.total_weeks == TOTAL_WEEKS
