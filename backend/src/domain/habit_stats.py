"""Domain logic for computing habit statistics from goal completions."""

from __future__ import annotations

from datetime import UTC, date, timedelta
from typing import TYPE_CHECKING

from domain.dates import to_user_date, today_in_tz
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
    """Sum units per JS day-of-week in user-local time (BUG-HABIT-006).

    Day-of-week buckets used to read straight from ``timestamp.weekday()``,
    which on Postgres ``timestamptz`` returns UTC weekday — so a Sunday-
    night Pacific completion (Monday in UTC) was charted under the wrong
    weekday.  Converting via :func:`domain.dates.to_user_date` first
    gives every user a chart aligned with their own week.

    Returns the unique completion dates as :class:`date` objects rather
    than ISO strings (BUG-HABIT-008): the streak / rate helpers used to
    re-parse those strings three separate times per call, which both
    wasted work and risked format drift if the ISO format ever changed.
    """
    units = [0.0] * _DAYS_IN_WEEK
    presence = [0] * _DAYS_IN_WEEK
    dates: set[date] = set()
    for c in completions:
        moment = c.timestamp if c.timestamp.tzinfo is not None else c.timestamp.replace(tzinfo=UTC)
        local_date = to_user_date(user_timezone, moment)
        js_idx = (local_date.weekday() + 1) % _DAYS_IN_WEEK
        units[js_idx] += c.completed_units
        presence[js_idx] = 1
        dates.add(local_date)
    return units, presence, dates


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
    """Return the current consecutive-day streak ending at the latest entry.

    Mirrors the recency gate in :mod:`services.streaks` so
    ``GET /habits/{id}/stats`` agrees with ``GET /habits`` after a missed
    day.  The "yesterday" grace window matches the rest of the streak
    code: one stale day is forgiven so the UI does not flash "streak
    lost" between local midnight and the user's first completion of
    the day.
    """
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


def _completion_rate(sorted_dates: list[date], unique_count: int, user_timezone: str) -> float:
    """Return ``unique_count / days_since_first`` in the user's calendar.

    BUG-HABIT-007: the previous formula divided by ``last - first + 1``,
    which meant a user who completed daily for a week then stopped for
    a year still showed ``1.0``.  Anchoring the denominator to "today
    in the user's local calendar" makes a paused habit's rate drift
    downward as expected, while the legacy single-day case
    (``first == today``) still resolves to ``1.0`` rather than dividing
    by zero.
    """
    if not sorted_dates:
        return 0.0
    first = sorted_dates[0]
    today = today_in_tz(user_timezone)
    span = (today - first).days + 1
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
    :func:`services.users.get_user_timezone` to opt into the user-local
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
        current_streak=_current_streak(sorted_dates, user_timezone),
        total_completions=len(completions),
        completion_rate=_completion_rate(sorted_dates, len(dates), user_timezone),
        completion_dates=[d.isoformat() for d in sorted_dates],
    )
