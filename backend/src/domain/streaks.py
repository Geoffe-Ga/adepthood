"""Streak management domain functions."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import TYPE_CHECKING

from domain.dates import to_user_date_bucket, today_in_tz

if TYPE_CHECKING:
    from collections.abc import Sequence

    from models.goal_completion import GoalCompletion

# Canonical weekday names accepted in ``Habit.notification_days``,
# mirroring ``date.strftime("%a")``.
WEEKDAY_ABBREVIATIONS: tuple[str, ...] = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
_VALID_WEEKDAY_LOWER: frozenset[str] = frozenset(d.lower() for d in WEEKDAY_ABBREVIATIONS)


def is_scheduled_on(notification_days: list[str] | None, weekday_name: str) -> bool:
    """Return True if ``weekday_name`` is in the cadence; raises on misspelled name."""
    target = weekday_name.lower()
    if target not in _VALID_WEEKDAY_LOWER:
        msg = f"weekday_name must be one of {WEEKDAY_ABBREVIATIONS}; got {weekday_name!r}"
        raise ValueError(msg)
    if not notification_days:
        return True
    return any(day.lower() == target for day in notification_days)


def update_streak(
    current_streak: int,
    *,
    did_check_in: bool,
    is_scheduled_today: bool = True,
) -> tuple[int, str]:
    """Increment on check-in, hold on unscheduled miss, reset on scheduled miss."""
    if did_check_in:
        return current_streak + 1, "streak_incremented"
    if not is_scheduled_today:
        return current_streak, "streak_held"
    return 0, "streak_reset"


@dataclass(frozen=True)
class SubtractiveContext:
    """Habit-level context required to compute a subtractive streak.

    Bundles the two values a subtractive-habit streak walk needs into a single
    kwarg so streak functions stay under the project's ``PLR0913`` (max-5-args)
    bar even after picking up the abstention code path.  ``clear_threshold`` is
    the day's failure cutoff (sum > threshold = transgression); ``start_date``
    is the habit's birth so the walk cannot accrue streak days before the habit
    existed.
    """

    clear_threshold: float
    start_date: date


def sum_units_by_user_day(
    completions: Sequence[GoalCompletion],
    user_timezone: str,
) -> dict[date, float]:
    """Sum completion units per user-local calendar day.

    The single owner of the ``day_totals[day] = get(day, 0.0) + units`` bucketing
    loop keyed on :func:`domain.dates.to_user_date_bucket`.  Used by both the
    in-memory streak path (``GET /habits``) and the per-goal stats/streak paths,
    which must agree or the same goal would report two different streaks.  No
    ``> 0`` filter is applied: subtractive habits treat the absence of a row as
    perfect abstention, so zero-sum days stay addressable via ``get(day, 0.0)``.
    """
    day_totals: dict[date, float] = {}
    for c in completions:
        day = to_user_date_bucket(c.timestamp, user_timezone)
        day_totals[day] = day_totals.get(day, 0.0) + c.completed_units
    return day_totals


def current_consecutive_streak(sorted_days_desc: Sequence[date], today: date) -> int:
    """Count the current additive consecutive-day streak (the single owner).

    The one canonical implementation of the additive streak the frontend
    ``streakFromCompletions`` helper mirrors; both ``GET /habits``
    (``services.streaks``) and ``GET /habits/{id}/stats`` (``domain.habit_stats``)
    delegate here so the same goal can never report two different streak counts.

    ``sorted_days_desc`` must be the distinct user-local completion days sorted
    *descending* (most recent first).  Two rules apply:

    * **Recency grace gate** — if the most recent day is older than yesterday
      (``most_recent < today - 1``) the chain is stale and the streak is 0.  The
      one-day grace prevents the UI flashing "streak lost" between local midnight
      and the user's first completion of the day; one stale day is forgiven, two
      is not.
    * **Backward walk** — starting from the most recent day, count days while
      each step back is exactly one calendar day; the first gap > 1 day ends the
      streak.

    Returns 0 for an empty sequence.
    """
    if not sorted_days_desc:
        return 0
    if sorted_days_desc[0] < today - timedelta(days=1):
        return 0
    streak = 1
    for i in range(1, len(sorted_days_desc)):
        if (sorted_days_desc[i - 1] - sorted_days_desc[i]).days != 1:
            break
        streak += 1
    return streak


def subtractive_current_streak(
    day_totals: dict[date, float],
    user_timezone: str,
    ctx: SubtractiveContext,
) -> int:
    """Count consecutive abstention days for a subtractive habit.

    Walks backwards from today; a day counts when its total is at most
    ``ctx.clear_threshold`` (trivially true for a day with no row).  Stops on a
    transgression (total above the threshold) or when the cursor crosses
    ``ctx.start_date``.  Returns 0 when the habit has not begun yet.
    """
    today = today_in_tz(user_timezone)
    if ctx.start_date > today:
        return 0
    streak = 0
    cursor = today
    while cursor >= ctx.start_date:
        if day_totals.get(cursor, 0.0) > ctx.clear_threshold:
            break
        streak += 1
        cursor -= timedelta(days=1)
    return streak


def subtractive_longest_streak(
    day_totals: dict[date, float],
    user_timezone: str,
    ctx: SubtractiveContext,
) -> int:
    """Longest no-transgression run across ``[start_date, today]``.

    Walks forwards from ``start_date``; each abstention day extends the current
    run (tracking the maximum), and a transgression resets it.  Returns 0 when
    the habit has not begun yet.
    """
    today = today_in_tz(user_timezone)
    if ctx.start_date > today:
        return 0
    longest = 0
    run = 0
    cursor = ctx.start_date
    while cursor <= today:
        if day_totals.get(cursor, 0.0) > ctx.clear_threshold:
            run = 0
        else:
            run += 1
            longest = max(longest, run)
        cursor += timedelta(days=1)
    return longest
