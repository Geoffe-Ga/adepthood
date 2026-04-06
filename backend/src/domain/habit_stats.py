"""Domain logic for computing habit statistics from goal completions."""

from __future__ import annotations

from datetime import date as date_type
from typing import TYPE_CHECKING

from schemas.habit_stats import HabitStats

if TYPE_CHECKING:
    from models.goal_completion import GoalCompletion

_DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
_DAYS_IN_WEEK = 7


def _empty_stats() -> HabitStats:
    return HabitStats(
        day_labels=list(_DAY_LABELS),
        values=[0.0] * _DAYS_IN_WEEK,
        completions_by_day=[0] * _DAYS_IN_WEEK,
        longest_streak=0,
        current_streak=0,
        total_completions=0,
        completion_rate=0.0,
        completion_dates=[],
    )


def _aggregate_by_day(
    completions: list[GoalCompletion],
) -> tuple[list[float], list[int], set[str]]:
    """Sum units per JS day-of-week and collect unique calendar dates."""
    units = [0.0] * _DAYS_IN_WEEK
    presence = [0] * _DAYS_IN_WEEK
    dates: set[str] = set()
    for c in completions:
        js_idx = (c.timestamp.weekday() + 1) % _DAYS_IN_WEEK
        units[js_idx] += c.completed_units
        presence[js_idx] = 1
        dates.add(c.timestamp.strftime("%Y-%m-%d"))
    return units, presence, dates


def _longest_streak(sorted_dates: list[str]) -> int:
    longest = 0
    run = 0
    prev: date_type | None = None
    for ds in sorted_dates:
        d = date_type.fromisoformat(ds)
        run = run + 1 if (prev is not None and (d - prev).days == 1) else 1
        longest = max(longest, run)
        prev = d
    return longest


def _current_streak(sorted_dates: list[str]) -> int:
    if not sorted_dates:
        return 0
    streak = 1
    for i in range(len(sorted_dates) - 2, -1, -1):
        cur = date_type.fromisoformat(sorted_dates[i])
        nxt = date_type.fromisoformat(sorted_dates[i + 1])
        if (nxt - cur).days == 1:
            streak += 1
        else:
            break
    return streak


def _completion_rate(sorted_dates: list[str], unique_count: int) -> float:
    if not sorted_dates:
        return 0.0
    first = date_type.fromisoformat(sorted_dates[0])
    last = date_type.fromisoformat(sorted_dates[-1])
    span = (last - first).days + 1
    return unique_count / span if span > 0 else 0.0


def compute_habit_stats(completions: list[GoalCompletion]) -> HabitStats:
    """Build aggregated stats from a flat list of goal completions."""
    if not completions:
        return _empty_stats()

    units, presence, dates = _aggregate_by_day(completions)
    sorted_dates = sorted(dates)

    return HabitStats(
        day_labels=list(_DAY_LABELS),
        values=units,
        completions_by_day=presence,
        longest_streak=_longest_streak(sorted_dates),
        current_streak=_current_streak(sorted_dates),
        total_completions=len(completions),
        completion_rate=_completion_rate(sorted_dates, len(dates)),
        completion_dates=sorted_dates,
    )
