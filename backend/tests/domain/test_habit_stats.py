"""Parity tests: habit-stats streak math must match the streak service (#781)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pytest

import domain.dates as dates_module
from domain.habit_stats import compute_habit_stats
from models.goal_completion import GoalCompletion
from services.streaks import compute_habit_streak

# Frozen so "yesterday/today" land deterministically (the streak walk reads
# today_in_tz -> now_in_tz); without this the test would be time-coupled.
_FROZEN_NOW = datetime(2026, 6, 15, 18, 0, tzinfo=UTC)


def _zone_for(user_or_tz: object) -> ZoneInfo:
    """Resolve an IANA zone from a tz string, UTC on failure (mirrors domain.dates)."""
    candidate = user_or_tz if isinstance(user_or_tz, str) else getattr(user_or_tz, "timezone", None)
    try:
        return ZoneInfo(candidate) if candidate else ZoneInfo("UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def _frozen_now_in_tz(user_or_tz: object = None) -> datetime:
    """Stand-in for ``domain.dates.now_in_tz`` pinned to :data:`_FROZEN_NOW`."""
    return _FROZEN_NOW.astimezone(_zone_for(user_or_tz))


@pytest.fixture
def frozen_clock(monkeypatch: pytest.MonkeyPatch) -> datetime:
    """Pin the wall clock so the streak window is date-independent."""
    monkeypatch.setattr(dates_module, "now_in_tz", _frozen_now_in_tz)
    return _FROZEN_NOW


def _completion(days_ago: int, units: float) -> GoalCompletion:
    """An in-memory completion ``days_ago`` before the frozen now."""
    return GoalCompletion(
        goal_id=1,
        user_id=1,
        completed_units=units,
        timestamp=_FROZEN_NOW - timedelta(days=days_ago),
    )


@pytest.mark.usefixtures("frozen_clock")
def test_stats_and_streak_agree_across_zero_unit_rows() -> None:
    """A ``completed_units == 0`` row must not inflate the stats streak (#781).

    ``GET /habits`` (``compute_habit_streak``) excludes did-not-complete rows;
    ``GET /habits/{id}/stats`` (``compute_habit_stats``) must report the same
    ``current_streak`` rather than counting the zero-unit row as a streak day.
    """
    completions = [
        _completion(days_ago=1, units=0.0),  # "did not complete" yesterday
        _completion(days_ago=0, units=2.0),  # completed today
    ]
    streak = compute_habit_streak(completions, "UTC")
    stats = compute_habit_stats(completions, "UTC")
    assert stats.current_streak == streak == 1
    # The zero-unit row is not a completion.
    assert stats.total_completions == 1


@pytest.mark.usefixtures("frozen_clock")
def test_stats_all_zero_rows_is_empty() -> None:
    """A habit whose only rows are did-not-complete reports a zero streak."""
    completions = [_completion(days_ago=0, units=0.0), _completion(days_ago=1, units=0.0)]
    stats = compute_habit_stats(completions, "UTC")
    assert stats.current_streak == 0
    assert stats.total_completions == 0
    assert stats.current_streak == compute_habit_streak(completions, "UTC")
