"""Period streaks: goals kept ``per_week`` / ``per_month`` count whole periods.

A goal of "3 sessions a day, 4 days a week" is complete for a week when four
of its Monday-to-Sunday days each reached three sessions. The streak counts
consecutive complete periods; the period in progress is not held against the
chain until it is over.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from domain.streaks import (
    Cadence,
    cadence_for_goal,
    cadence_for_goals,
    period_current_streak,
    period_longest_streak,
    period_progress,
    period_start,
    streak_unit_for,
)
from models.goal import Goal

# Wednesday 2026-10-07; its week runs Monday 2026-10-05 .. Sunday 2026-10-11.
_TODAY = date(2026, 10, 7)
_THIS_MONDAY = date(2026, 10, 5)
_WEEKLY = Cadence(unit="week", days_needed=4, day_target=3.0)
_MONTHLY = Cadence(unit="month", days_needed=4, day_target=1.0)


def _goal(
    frequency_unit: str, frequency: float = 4.0, target: float = 3.0, tier: str = "low"
) -> Goal:
    return Goal(
        habit_id=1,
        title="t",
        tier=tier,
        target=target,
        target_unit="units",
        frequency=frequency,
        frequency_unit=frequency_unit,
    )


def _week_of(monday: date, done_days: int, units: float = 3.0) -> dict[date, float]:
    """``done_days`` days of ``units`` each, starting on ``monday``."""
    return {monday + timedelta(days=i): units for i in range(done_days)}


# ---------------------------------------------------------------------------
# Cadence from goals
# ---------------------------------------------------------------------------


def test_a_per_day_goal_has_no_cadence() -> None:
    assert cadence_for_goal(_goal("per_day")) is None
    assert streak_unit_for(None) == "day"


def test_a_per_week_goal_counts_days_per_week_at_its_own_day_target() -> None:
    cadence = cadence_for_goal(_goal("per_week", frequency=4.0, target=3.0))
    assert cadence == Cadence(unit="week", days_needed=4, day_target=3.0)
    assert streak_unit_for(cadence) == "week"


def test_a_per_month_goal_counts_days_per_month() -> None:
    cadence = cadence_for_goal(_goal("per_month", frequency=2.5, target=1.0))
    assert cadence == Cadence(unit="month", days_needed=3, day_target=1.0)
    assert streak_unit_for(cadence) == "month"


def test_days_needed_is_never_below_one() -> None:
    assert cadence_for_goal(_goal("per_week", frequency=0.0)).days_needed == 1  # type: ignore[union-attr]


def test_an_unknown_frequency_unit_has_no_cadence() -> None:
    assert cadence_for_goal(_goal("per_session")) is None


def test_the_habit_cadence_is_the_low_tiers() -> None:
    """The floor decides whether a day and a week count -- the daily chain's any-unit spirit."""
    goals = [
        _goal("per_week", frequency=5.0, target=3.0, tier="stretch"),
        _goal("per_week", frequency=4.0, target=1.0, tier="low"),
    ]
    assert cadence_for_goals(goals) == Cadence(unit="week", days_needed=4, day_target=1.0)


def test_a_ladder_without_a_low_tier_is_daily_as_the_client_reads_it() -> None:
    goals = [_goal("per_month", frequency=2.0, target=2.0, tier="clear")]
    assert cadence_for_goals(goals) is None
    assert cadence_for_goals([]) is None


# ---------------------------------------------------------------------------
# Period boundaries
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("day", "expected"),
    [
        (date(2026, 10, 5), date(2026, 10, 5)),  # a Monday starts its own week
        (date(2026, 10, 11), date(2026, 10, 5)),  # a Sunday ends it
        (date(2026, 10, 12), date(2026, 10, 12)),
    ],
)
def test_weeks_run_monday_to_sunday(day: date, expected: date) -> None:
    assert period_start(day, "week") == expected


def test_months_are_calendar_months() -> None:
    assert period_start(date(2026, 10, 31), "month") == date(2026, 10, 1)


# ---------------------------------------------------------------------------
# Current streak
# ---------------------------------------------------------------------------


def test_no_completions_is_no_streak() -> None:
    assert period_current_streak({}, _TODAY, _WEEKLY) == 0


def test_a_day_counts_only_once_it_reaches_the_day_target() -> None:
    """Two sessions on a three-a-day goal is progress, not a done day."""
    short = _week_of(_THIS_MONDAY - timedelta(days=7), done_days=4, units=2.0)
    assert period_current_streak(short, _TODAY, _WEEKLY) == 0
    assert period_progress(short, _THIS_MONDAY - timedelta(days=1), _WEEKLY) == (0, 4)


def test_a_complete_previous_week_with_this_week_in_progress_is_one_week() -> None:
    """Four done days last week, two so far this week: "1 week, 2/4 days"."""
    totals = _week_of(_THIS_MONDAY - timedelta(days=7), done_days=4)
    totals.update(_week_of(_THIS_MONDAY, done_days=2))
    assert period_current_streak(totals, _TODAY, _WEEKLY) == 1
    assert period_progress(totals, _TODAY, _WEEKLY) == (2, 4)


def test_a_complete_current_week_counts_itself() -> None:
    totals = _week_of(_THIS_MONDAY - timedelta(days=7), done_days=4)
    totals.update(_week_of(_THIS_MONDAY, done_days=4))
    assert period_current_streak(totals, _TODAY, _WEEKLY) == 2


def test_an_incomplete_previous_week_breaks_the_chain() -> None:
    """The week before last was complete; last week was not: nothing carries."""
    totals = _week_of(_THIS_MONDAY - timedelta(days=14), done_days=4)
    totals.update(_week_of(_THIS_MONDAY - timedelta(days=7), done_days=3))
    assert period_current_streak(totals, _TODAY, _WEEKLY) == 0


def test_consecutive_complete_weeks_are_counted_back_until_a_gap() -> None:
    totals: dict[date, float] = {}
    for weeks_ago in (1, 2, 3, 5):
        totals.update(_week_of(_THIS_MONDAY - timedelta(days=7 * weeks_ago), done_days=4))
    assert period_current_streak(totals, _TODAY, _WEEKLY) == 3


def test_extra_days_in_a_week_do_not_count_twice() -> None:
    totals = _week_of(_THIS_MONDAY - timedelta(days=7), done_days=7)
    assert period_current_streak(totals, _TODAY, _WEEKLY) == 1
    assert period_progress(totals, _THIS_MONDAY - timedelta(days=1), _WEEKLY) == (7, 4)


def test_monthly_cadence_walks_calendar_months() -> None:
    september = {date(2026, 9, d): 1.0 for d in (1, 10, 20, 30)}
    august = {date(2026, 8, d): 1.0 for d in (2, 3, 4, 5)}
    assert period_current_streak({**september, **august}, _TODAY, _MONTHLY) == 2
    assert period_progress({**september, **august}, _TODAY, _MONTHLY) == (0, 4)


# ---------------------------------------------------------------------------
# Longest streak
# ---------------------------------------------------------------------------


def test_longest_run_of_adjacent_complete_periods() -> None:
    totals: dict[date, float] = {}
    for weeks_ago in (1, 3, 4, 5, 8):
        totals.update(_week_of(_THIS_MONDAY - timedelta(days=7 * weeks_ago), done_days=4))
    assert period_longest_streak(totals, _WEEKLY) == 3


def test_longest_is_zero_without_a_complete_period() -> None:
    totals = _week_of(_THIS_MONDAY - timedelta(days=7), done_days=3)
    assert period_longest_streak(totals, _WEEKLY) == 0
