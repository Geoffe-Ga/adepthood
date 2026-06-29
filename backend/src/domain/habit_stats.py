"""Domain logic for computing habit statistics from goal completions."""

from __future__ import annotations

from datetime import UTC, date, timedelta
from typing import TYPE_CHECKING

from domain.dates import to_user_date, today_in_tz
from domain.streaks import (
    SubtractiveContext,
    subtractive_current_streak,
    subtractive_day_totals,
    subtractive_longest_streak,
)
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
) -> tuple[list[float], list[int], set[date]]:
    """Sum units + count events per JS weekday; returns dates as ``date`` objects."""
    units = [0.0] * _DAYS_IN_WEEK
    counts = [0] * _DAYS_IN_WEEK
    dates: set[date] = set()
    for c in completions:
        moment = c.timestamp if c.timestamp.tzinfo is not None else c.timestamp.replace(tzinfo=UTC)
        local_date = to_user_date(user_timezone, moment)
        js_idx = (local_date.weekday() + 1) % _DAYS_IN_WEEK
        units[js_idx] += c.completed_units
        counts[js_idx] += 1
        dates.add(local_date)
    return units, counts, dates


def _longest_streak(sorted_dates: list[date]) -> int:
    longest = 0
    run = 0
    prev: date | None = None
    for d in sorted_dates:
        run = run + 1 if (prev is not None and (d - prev).days == 1) else 1
        longest = max(longest, run)
        prev = d
    return longest


def _current_streak(sorted_dates: list[date], user_timezone: str) -> int:
    """Return the current consecutive-day streak with a one-day grace at midnight."""
    if not sorted_dates:
        return 0
    most_recent = sorted_dates[-1]
    today = today_in_tz(user_timezone)
    yesterday = today - timedelta(days=1)
    if most_recent < yesterday:
        return 0
    streak = 1
    for i in range(len(sorted_dates) - 2, -1, -1):
        if (sorted_dates[i + 1] - sorted_dates[i]).days == 1:
            streak += 1
        else:
            break
    return streak


def _completion_rate(sorted_dates: list[date], user_timezone: str) -> float:
    """Return ``len(sorted_dates) / days_since_first`` in the user's calendar."""
    if not sorted_dates:
        return 0.0
    first = sorted_dates[0]
    today = today_in_tz(user_timezone)
    span = (today - first).days + 1
    return len(sorted_dates) / span if span > 0 else 0.0


def _subtractive_stats(
    completions: list[GoalCompletion],
    user_timezone: str,
    ctx: SubtractiveContext,
) -> HabitStats:
    """Subtractive variant of :func:`compute_habit_stats`.

    Day-of-week / completion-rate / total-completions stay rooted in
    the additive bucketing because they describe "what the user logged"
    -- pre-existing semantics this PR explicitly leaves unchanged.
    Only the two streak fields flip polarity, which is the visible
    inconsistency that PR #379 review surfaced.
    """
    units, presence, dates = _aggregate_by_day(completions, user_timezone)
    sorted_dates = sorted(dates)
    day_totals = subtractive_day_totals(completions, user_timezone)
    return HabitStats(
        day_labels=list(_DAY_LABELS),
        values=units,
        completions_by_day=presence,
        longest_streak=subtractive_longest_streak(day_totals, user_timezone, ctx),
        current_streak=subtractive_current_streak(day_totals, user_timezone, ctx),
        total_completions=len(completions),
        completion_rate=_completion_rate(sorted_dates, user_timezone),
        completion_dates=[d.isoformat() for d in sorted_dates],
    )


def compute_habit_stats(
    completions: list[GoalCompletion],
    user_timezone: str = "UTC",
    subtractive: SubtractiveContext | None = None,
) -> HabitStats:
    """Aggregate completions into stats using the user's local calendar.

    Pass ``subtractive`` for habits where success is staying *under* a
    threshold ("abstain from sugar"): the two streak fields then walk
    backwards/forwards across ``[start_date, today]`` counting absent
    days as abstention wins rather than data gaps.  Without it the
    additive path runs, preserving the legacy behavior for every
    existing caller.
    """
    if subtractive is not None:
        return _subtractive_stats(completions, user_timezone, subtractive)
    if not completions:
        return _empty_stats()

    units, counts, dates = _aggregate_by_day(completions, user_timezone)
    sorted_dates = sorted(dates)

    return HabitStats(
        day_labels=list(_DAY_LABELS),
        values=units,
        completions_by_day=counts,
        longest_streak=_longest_streak(sorted_dates),
        current_streak=_current_streak(sorted_dates, user_timezone),
        total_completions=len(completions),
        completion_rate=_completion_rate(sorted_dates, user_timezone),
        completion_dates=[d.isoformat() for d in sorted_dates],
    )
