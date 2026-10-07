"""Streak management domain functions."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import TYPE_CHECKING, Literal

from domain.dates import today_in_tz

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


# Goal cadences whose streak counts completed periods instead of days.
PeriodUnit = Literal["per_week", "per_month"]

PERIOD_UNITS: frozenset[str] = frozenset({"per_week", "per_month"})

_DAYS_PER_WEEK = 7
# Any day 32 days after the 1st of a month falls inside the following month.
_DAYS_PAST_MONTH_START = 32


@dataclass(frozen=True)
class PeriodCadence:
    """Everything a period-based (weekly / monthly) streak walk needs.

    A habit whose goals are ``per_week`` or ``per_month`` is scored in
    periods, not days (#2819): an ISO week starting Monday, or a calendar
    month, in the user's calendar. A period is *met* when its summed units
    reach ``period_target`` (the clear tier's ``target * frequency``) for an
    additive habit, or stay at or under it for a subtractive one.
    ``start_date`` is the habit's birth: a subtractive walk starts at the
    period *containing* it and never counts an earlier one, since an absent
    row there is not an abstention. A habit begun mid-period has that whole
    first period judged on the days it existed (the earlier days carry no
    rows), so staying within the limit since the start counts it as met.
    """

    unit: PeriodUnit
    period_target: float
    start_date: date
    subtractive: bool


def period_start(day: date, unit: PeriodUnit) -> date:
    """Return the first day of ``day``'s period: its ISO Monday or the 1st."""
    if unit == "per_week":
        return day - timedelta(days=day.weekday())
    return day.replace(day=1)


def _previous_period(start: date, unit: PeriodUnit) -> date:
    """Return the start of the period before the one beginning at ``start``."""
    if unit == "per_week":
        return start - timedelta(days=_DAYS_PER_WEEK)
    return (start - timedelta(days=1)).replace(day=1)


def _next_period(start: date, unit: PeriodUnit) -> date:
    """Return the start of the period after the one beginning at ``start``."""
    if unit == "per_week":
        return start + timedelta(days=_DAYS_PER_WEEK)
    return (start + timedelta(days=_DAYS_PAST_MONTH_START)).replace(day=1)


def _period_totals(day_totals: dict[date, float], unit: PeriodUnit) -> dict[date, float]:
    """Re-bucket per-day totals into per-period totals keyed by period start."""
    totals: dict[date, float] = {}
    for day, units in day_totals.items():
        key = period_start(day, unit)
        totals[key] = totals.get(key, 0.0) + units
    return totals


def _period_met(total: float, cadence: PeriodCadence) -> bool:
    """Whether a period's summed units satisfy the cadence's clear target."""
    if cadence.subtractive:
        return total <= cadence.period_target
    return total >= cadence.period_target


def _first_period(day_totals: dict[date, float], cadence: PeriodCadence) -> date:
    """Earliest period a walk may count.

    Subtractive walks start at the habit's birth. Additive walks also reach
    back to the earliest logged day, matching the day-based additive streak,
    which never consults ``start_date``.
    """
    first = period_start(cadence.start_date, cadence.unit)
    if cadence.subtractive or not day_totals:
        return first
    return min(first, period_start(min(day_totals), cadence.unit))


def period_current_streak(
    day_totals: dict[date, float], today: date, cadence: PeriodCadence
) -> int:
    """Count the current streak of consecutive met periods (the single owner).

    The period analogue of :func:`current_consecutive_streak`, mirrored by the
    frontend ``periodStreakFromCompletions``. The still-open period (the one
    containing ``today``) counts when already met and is grace otherwise: it
    never breaks the chain while it can still be met. Walking back from the
    most recent *closed* period, each met period extends the streak and the
    first unmet one ends it, so an unmet last closed period with an unmet open
    period yields 0.
    """
    unit = cadence.unit
    totals = _period_totals(day_totals, unit)
    first = _first_period(day_totals, cadence)
    open_period = period_start(today, unit)
    if first > open_period:
        return 0
    streak = 1 if _period_met(totals.get(open_period, 0.0), cadence) else 0
    cursor = _previous_period(open_period, unit)
    while cursor >= first and _period_met(totals.get(cursor, 0.0), cadence):
        streak += 1
        cursor = _previous_period(cursor, unit)
    return streak


def period_longest_streak(
    day_totals: dict[date, float], today: date, cadence: PeriodCadence
) -> int:
    """Longest run of consecutive met periods up to and including the open one.

    Walks forwards from the first countable period. A met period extends the
    run; an unmet *closed* period resets it, while an unmet open period simply
    does not extend it (the same grace :func:`period_current_streak` gives).
    """
    unit = cadence.unit
    totals = _period_totals(day_totals, unit)
    open_period = period_start(today, unit)
    longest = 0
    run = 0
    cursor = _first_period(day_totals, cadence)
    while cursor <= open_period:
        if _period_met(totals.get(cursor, 0.0), cadence):
            run += 1
            longest = max(longest, run)
        elif cursor != open_period:
            run = 0
        cursor = _next_period(cursor, unit)
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
