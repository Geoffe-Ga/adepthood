"""Streak management domain functions.

Two kinds of chain live here. The **daily** chain (the default) counts
consecutive user-local days with any completed units. The **period** chain
covers goals kept ``per_week`` or ``per_month``: "3 sessions a day, 4 days a
week" is complete for a week when four of its Monday-to-Sunday days each
reached three sessions, and the streak counts consecutive complete periods.
:class:`Cadence` carries that reading of a goal; ``None`` means daily.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, timedelta
from typing import TYPE_CHECKING, Literal

from domain.dates import today_in_tz

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence

    from models.goal import Goal
    from models.goal_completion import GoalCompletion

PeriodUnit = Literal["week", "month"]
# What one unit of a streak is, as the client should word it.
StreakUnit = Literal["day", "week", "month"]

_PERIOD_UNITS: dict[str, PeriodUnit] = {"per_week": "week", "per_month": "month"}
_DAYS_PER_WEEK = 7
# A period needs at least one done day to mean anything; a frequency the
# editor let through at zero would otherwise mark every period complete.
_MIN_DAYS_NEEDED = 1

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


@dataclass(frozen=True)
class Cadence:
    """How a ``per_week`` / ``per_month`` goal is counted.

    ``goal.target`` is always the amount for one DAY; ``goal.frequency`` is
    how many such days a period needs. So a day is *done* when its total
    reaches ``day_target``, and a period is *complete* when at least
    ``days_needed`` of its days are done. Weeks run Monday to Sunday and
    months are calendar months, both in the user's own calendar (the day
    totals arrive already bucketed into user-local days).
    """

    unit: PeriodUnit
    days_needed: int
    day_target: float


def cadence_for_goal(goal: Goal) -> Cadence | None:
    """The period cadence ``goal`` is kept at, or ``None`` for a daily goal."""
    unit = _PERIOD_UNITS.get(goal.frequency_unit)
    if unit is None:
        return None
    needed = math.ceil(goal.frequency) if math.isfinite(goal.frequency) else _MIN_DAYS_NEEDED
    return Cadence(unit=unit, days_needed=max(_MIN_DAYS_NEEDED, needed), day_target=goal.target)


def cadence_for_goals(goals: Sequence[Goal]) -> Cadence | None:
    """The cadence a HABIT is counted at: its low tier's, else daily.

    The low tier is the floor -- the least a day and a period must hold to
    count -- which is the same spirit as the daily chain counting any logged
    unit. The tiers share one ``frequency_unit`` (the editor writes it to all
    three at once), so only the per-day target and days-per-period differ. A
    ladder with no low tier is read as daily, as the client's ``habitCadence``
    reads it, so the tile and the server never count different things.
    """
    low = next((goal for goal in goals if goal.tier == "low"), None)
    return None if low is None else cadence_for_goal(low)


def streak_unit_for(cadence: Cadence | None) -> StreakUnit:
    """The word a streak of this cadence counts in."""
    return "day" if cadence is None else cadence.unit


def period_start(day: date, unit: PeriodUnit) -> date:
    """The first day of the period ``day`` falls in: its Monday, or the 1st."""
    if unit == "week":
        return day - timedelta(days=day.weekday())
    return day.replace(day=1)


def _previous_period_start(start: date, unit: PeriodUnit) -> date:
    """The start of the period before the one starting at ``start``."""
    if unit == "week":
        return start - timedelta(days=_DAYS_PER_WEEK)
    return (start - timedelta(days=1)).replace(day=1)


def _next_period_start(start: date, unit: PeriodUnit) -> date:
    """The start of the period after the one starting at ``start``."""
    if unit == "week":
        return start + timedelta(days=_DAYS_PER_WEEK)
    return (start + timedelta(days=_DAYS_PER_WEEK * 5)).replace(day=1)


def _done_days(day_totals: dict[date, float], cadence: Cadence) -> set[date]:
    """The days whose total reached the day target (and is positive)."""
    return {d for d, total in day_totals.items() if total > 0 and total >= cadence.day_target}


def _days_done_in(done: Iterable[date], start: date, cadence: Cadence) -> int:
    """How many of ``done`` fall in the period starting at ``start``."""
    end = _next_period_start(start, cadence.unit)
    return sum(1 for d in done if start <= d < end)


def _is_complete(done: set[date], start: date, cadence: Cadence) -> bool:
    return _days_done_in(done, start, cadence) >= cadence.days_needed


def period_progress(
    day_totals: dict[date, float], today: date, cadence: Cadence
) -> tuple[int, int]:
    """``(days done, days needed)`` for the period ``today`` falls in."""
    start = period_start(today, cadence.unit)
    return _days_done_in(_done_days(day_totals, cadence), start, cadence), cadence.days_needed


def period_current_streak(day_totals: dict[date, float], today: date, cadence: Cadence) -> int:
    """Consecutive complete periods, counted back from the current one.

    The current period counts when it is already complete; otherwise it is
    still in progress and is passed over rather than breaking the chain --
    the period analogue of the daily chain's one-day grace. From there each
    earlier period must be complete, and the first that is not ends the walk.
    """
    done = _done_days(day_totals, cadence)
    if not done:
        return 0
    cursor = period_start(today, cadence.unit)
    if not _is_complete(done, cursor, cadence):
        cursor = _previous_period_start(cursor, cadence.unit)
    streak = 0
    while _is_complete(done, cursor, cadence):
        streak += 1
        cursor = _previous_period_start(cursor, cadence.unit)
    return streak


def period_longest_streak(day_totals: dict[date, float], cadence: Cadence) -> int:
    """The longest run of calendar-adjacent complete periods, ever."""
    done = _done_days(day_totals, cadence)
    longest = run = 0
    previous: date | None = None
    for start in sorted({period_start(d, cadence.unit) for d in done}):
        if not _is_complete(done, start, cadence):
            run, previous = 0, None
            continue
        adjacent = previous is not None and _previous_period_start(start, cadence.unit) == previous
        run = run + 1 if adjacent else 1
        longest = max(longest, run)
        previous = start
    return longest


def sum_units_by_user_day(
    completions: Sequence[GoalCompletion],
) -> dict[date, float]:
    """Sum completion units by their persisted user-local calendar day.

    The single owner of the ``day_totals[day] = get(day, 0.0) + units`` bucketing
    loop keyed on ``GoalCompletion.local_day``.  That column is the canonical
    calendar identity used by writes and database uniqueness; ``timestamp`` is
    immutable audit provenance and may reflect a former account timezone.  The
    in-memory streak path (``GET /habits``) and per-goal stats/streak paths all
    use this helper so they cannot disagree after an account-timezone change.
    No ``> 0`` filter is applied: subtractive habits treat the absence of a row
    as perfect abstention, so zero-sum days stay addressable via
    ``get(day, 0.0)``.
    """
    day_totals: dict[date, float] = {}
    for c in completions:
        day = c.local_day
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
