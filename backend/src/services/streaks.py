"""Streak and milestone services — DB-aware wrappers over pure domain logic.

Routers call these helpers instead of computing streaks inline so the same
logic can be reused from background jobs, admin tools, and tests without
needing HTTP fixtures.  Pure functions stay in :mod:`domain.streaks` so they
remain trivially unit-testable; this module only adds the DB-query layer that
composes them into a request-ready result.

Streak dates are reduced to *user-local* calendar days (BUG-STREAK-002).
Storing timestamps in UTC and then bucketing with ``.date()`` would tick
streaks over at the server's midnight rather than the user's, breaking
West-Coast users by 7-8 hours every day.  All conversion goes through
:func:`domain.dates.to_user_date`, which preserves DST jumps and never
silently coerces naive datetimes.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.dates import to_user_date_bucket, today_in_tz
from domain.streaks import (
    SubtractiveContext,
    current_consecutive_streak,
    subtractive_current_streak,
    sum_units_by_user_day,
)
from models.goal_completion import GoalCompletion
from schemas.milestone import Milestone

__all__ = [
    "PendingCompletion",
    "StreakScope",
    "SubtractiveContext",
    "check_milestones",
    "compute_consecutive_streak",
    "compute_habit_streak",
    "compute_streak_before_and_after",
]


async def compute_consecutive_streak(
    session: AsyncSession,
    goal_id: int,
    user_id: int,
    user_timezone: str = "UTC",
    subtractive: SubtractiveContext | None = None,
) -> int:
    """Count consecutive *days* with completed check-ins for a goal.

    Collapses multiple rows on the same calendar day into a single day,
    fixing BUG-HABITS-011 where the old code counted rows instead of
    unique days.  ``user_timezone`` selects which calendar's "day"
    boundary applies (BUG-STREAK-002); routers should pass
    :func:`services.users.get_user_timezone` so streaks tick over at the
    user's midnight rather than UTC's.

    For subtractive habits, pass ``subtractive`` to flip the success
    polarity: a day with no log = perfect abstention (success), and the
    chain only breaks on a day where the user logged above
    ``subtractive.clear_threshold``.  Omitting ``subtractive`` keeps
    legacy additive behavior, so callers that don't know the habit's
    polarity stay safe.
    """
    day_totals = await _fetch_day_totals(session, goal_id, user_id, user_timezone)
    return _streak_from_day_totals(day_totals, user_timezone, subtractive)


async def _fetch_day_totals(
    session: AsyncSession, goal_id: int, user_id: int, user_timezone: str
) -> dict[date, float]:
    """Sum a goal's completion units per user-local calendar day (one query)."""
    rows = await session.execute(
        select(GoalCompletion)
        .where(GoalCompletion.goal_id == goal_id, GoalCompletion.user_id == user_id)
        .order_by(col(GoalCompletion.timestamp).desc())
    )
    return sum_units_by_user_day(rows.scalars().all(), user_timezone)


def _additive_streak_from_day_totals(day_totals: dict[date, float], user_timezone: str) -> int:
    """Additive consecutive-day streak from bucketed per-day totals.

    Backs :func:`compute_consecutive_streak` and
    :func:`compute_streak_before_and_after` — the per-goal DB / check-in +
    milestone path.  It filters ``day_totals`` to the user-local days that were
    actually completed (total > 0) and delegates the ordering-sensitive work to
    the shared :func:`domain.streaks.current_consecutive_streak`, which owns the
    recency grace gate + backward walk (and returns 0 for an empty sequence).

    Because only completed days are passed on, a most-recent
    ``completed_units == 0`` "did not complete" row is ignored like an absent
    day.  That keeps this DB path in lockstep with the in-memory
    :func:`services.streaks.compute_habit_streak` path, which applies the same
    completed-days filter + grace gate.
    """
    completed_days = sorted((d for d in day_totals if day_totals[d] > 0), reverse=True)
    return current_consecutive_streak(completed_days, today_in_tz(user_timezone))


def _streak_from_day_totals(
    day_totals: dict[date, float],
    user_timezone: str,
    subtractive: SubtractiveContext | None,
) -> int:
    """Count the consecutive-day streak from pre-bucketed day totals."""
    if subtractive is not None:
        return subtractive_current_streak(day_totals, user_timezone, subtractive)
    return _additive_streak_from_day_totals(day_totals, user_timezone)


@dataclass(frozen=True)
class StreakScope:
    """The goal + calendar + polarity that fully specify a streak computation."""

    goal_id: int
    user_id: int
    user_timezone: str
    subtractive: SubtractiveContext | None


@dataclass(frozen=True)
class PendingCompletion:
    """A not-yet-persisted completion to fold into the post-insert streak."""

    day: date
    units: float


async def compute_streak_before_and_after(
    session: AsyncSession,
    scope: StreakScope,
    pending: PendingCompletion,
) -> tuple[int, int]:
    """Return ``(streak_before, streak_after)`` from a single history read.

    Lets the check-in path obtain the pre- and post-insert streak without
    computing the streak twice. ``pending`` is folded into the day buckets
    exactly as the about-to-be-inserted ``GoalCompletion`` would be, so
    ``streak_after`` matches recomputing after the insert.
    """
    day_totals = await _fetch_day_totals(session, scope.goal_id, scope.user_id, scope.user_timezone)
    before = _streak_from_day_totals(day_totals, scope.user_timezone, scope.subtractive)
    after_totals = dict(day_totals)
    after_totals[pending.day] = after_totals.get(pending.day, 0.0) + pending.units
    after = _streak_from_day_totals(after_totals, scope.user_timezone, scope.subtractive)
    return before, after


def _completed_user_dates(
    completions: Sequence[GoalCompletion],
    user_timezone: str,
) -> set[date]:
    """Return the set of user-local calendar days where the goal was met.

    Split out so :func:`compute_habit_streak` stays at xenon rank A; the
    inner generator + filter pushed the parent block over the threshold.
    """
    return {
        to_user_date_bucket(c.timestamp, user_timezone)
        for c in completions
        if c.completed_units > 0
    }


def compute_habit_streak(
    completions: Sequence[GoalCompletion],
    user_timezone: str = "UTC",
    subtractive: SubtractiveContext | None = None,
) -> int:
    """Compute current consecutive-day streak from in-memory completions.

    Used by ``GET /habits`` to populate streak without a per-goal DB query.
    ``user_timezone`` mirrors the database path's parameter
    (BUG-STREAK-002) — both call sites must agree or the same goal would
    show two different streak counts depending on whether it was loaded
    via the in-memory or per-goal path.

    For **additive** habits (the default — ``subtractive=None``),
    enforces the recency gate the frontend ``streakFromCompletions``
    helper uses (BUG-FE-HABIT-207): if the most recent completion is
    older than yesterday in the user's calendar, the streak is broken
    and the helper returns 0.

    For **subtractive** habits (e.g. "abstain from sugar") a day with
    *no* log is the best possible outcome, so the recency gate would
    invert the correct behavior.  Pass a :class:`SubtractiveContext`
    bundling the sibling clear-tier goal's target and the habit's
    ``start_date`` to walk backwards counting abstention days instead.
    """
    if subtractive is not None:
        day_totals = sum_units_by_user_day(completions, user_timezone)
        return subtractive_current_streak(day_totals, user_timezone, subtractive)
    sorted_dates = sorted(_completed_user_dates(completions, user_timezone), reverse=True)
    return current_consecutive_streak(sorted_dates, today_in_tz(user_timezone))


def check_milestones(
    new_streak: int,
    thresholds: list[int],
    old_streak: int = 0,
) -> list[Milestone]:
    """Return milestones *newly crossed* between ``old_streak`` and ``new_streak``.

    Only thresholds where ``old_streak < t <= new_streak`` are returned,
    preventing duplicate milestone toasts on retries (BUG-HABITS-008).
    """
    reached = [t for t in thresholds if old_streak < t <= new_streak]
    return [Milestone(threshold=t) for t in reached]
