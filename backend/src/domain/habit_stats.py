"""Domain logic for computing habit statistics from goal completions."""

from __future__ import annotations

from datetime import UTC, date
from typing import TYPE_CHECKING

from domain.dates import to_user_date
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
    user_timezone: str,
) -> tuple[list[float], list[int], set[str]]:
    """Sum units per JS day-of-week in user-local time (BUG-HABIT-006).

    Day-of-week buckets used to read straight from ``timestamp.weekday()``,
    which on Postgres ``timestamptz`` returns UTC weekday — so a Sunday-
    night Pacific completion (Monday in UTC) was charted under the wrong
    weekday.  Converting via :func:`domain.dates.to_user_date` first
    gives every user a chart aligned with their own week.
    """
    units = [0.0] * _DAYS_IN_WEEK
    presence = [0] * _DAYS_IN_WEEK
    dates: set[str] = set()
    for c in completions:
        moment = c.timestamp if c.timestamp.tzinfo is not None else c.timestamp.replace(tzinfo=UTC)
        local_date = to_user_date(user_timezone, moment)
        js_idx = (local_date.weekday() + 1) % _DAYS_IN_WEEK
        units[js_idx] += c.completed_units
        presence[js_idx] = 1
        dates.add(local_date.isoformat())
    return units, presence, dates


def _longest_streak(sorted_dates: list[str]) -> int:
    longest = 0
    run = 0
    prev: date | None = None
    for ds in sorted_dates:
        d = date.fromisoformat(ds)
        run = run + 1 if (prev is not None and (d - prev).days == 1) else 1
        longest = max(longest, run)
        prev = d
    return longest


def _current_streak(sorted_dates: list[str]) -> int:
    if not sorted_dates:
        return 0
    streak = 1
    for i in range(len(sorted_dates) - 2, -1, -1):
        cur = date.fromisoformat(sorted_dates[i])
        nxt = date.fromisoformat(sorted_dates[i + 1])
        if (nxt - cur).days == 1:
            streak += 1
        else:
            break
    return streak


def _completion_rate(sorted_dates: list[str], unique_count: int) -> float:
    if not sorted_dates:
        return 0.0
    first = date.fromisoformat(sorted_dates[0])
    last = date.fromisoformat(sorted_dates[-1])
    span = (last - first).days + 1
    return unique_count / span if span > 0 else 0.0


def compute_habit_stats(
    completions: list[GoalCompletion],
    user_timezone: str = "UTC",
) -> HabitStats:
    """Build aggregated stats from a flat list of goal completions.

    ``user_timezone`` selects the calendar used for day-of-week buckets,
    streak runs, and completion-rate spans (BUG-HABIT-006).  The default
    is ``"UTC"`` so legacy callers that omit the argument keep their
    pre-fix behaviour rather than silently switching zones; routers pass
    :func:`domain.dates.get_user_timezone` to opt into the user-local
    view.
    """
    if not completions:
        return _empty_stats()

    units, presence, dates = _aggregate_by_day(completions, user_timezone)
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
