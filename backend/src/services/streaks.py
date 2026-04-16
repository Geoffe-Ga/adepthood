"""Streak and milestone services — DB-aware wrappers over pure domain logic.

Routers call these helpers instead of computing streaks inline so the same
logic can be reused from background jobs, admin tools, and tests without
needing HTTP fixtures.  Pure functions stay in :mod:`domain.streaks` and
:mod:`domain.milestones` so they remain trivially unit-testable; this module
only adds the DB-query layer that composes them into a request-ready
result.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date as date_type

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.streaks import update_streak
from models.goal_completion import GoalCompletion
from schemas.milestone import Milestone

__all__ = [
    "check_milestones",
    "compute_consecutive_streak",
    "compute_habit_streak",
    "update_streak",
]


def _to_date(ts: object) -> date_type:
    """Extract a calendar date from a timestamp (datetime or string)."""
    return ts.date() if hasattr(ts, "date") else date_type.fromisoformat(str(ts)[:10])


def _count_consecutive_days(sorted_days: list[date_type], day_ok: dict[date_type, bool]) -> int:
    """Count consecutive days from most recent where ``day_ok`` is True."""
    streak = 0
    for i, day in enumerate(sorted_days):
        if not day_ok[day]:
            break
        if i > 0 and (sorted_days[i - 1] - day).days != 1:
            break
        streak += 1
    return streak


async def compute_consecutive_streak(
    session: AsyncSession,
    goal_id: int,
    user_id: int,
) -> int:
    """Count consecutive *days* with completed check-ins for a goal.

    Collapses multiple rows on the same calendar day into a single day,
    fixing BUG-HABITS-011 where the old code counted rows instead of
    unique days.
    """
    rows = await session.execute(
        select(GoalCompletion.timestamp, GoalCompletion.completed_units)
        .where(GoalCompletion.goal_id == goal_id, GoalCompletion.user_id == user_id)
        .order_by(col(GoalCompletion.timestamp).desc())
    )

    day_totals: dict[date_type, float] = {}
    for ts, units in rows:
        day = _to_date(ts)
        day_totals[day] = day_totals.get(day, 0.0) + units

    sorted_days = sorted(day_totals, reverse=True)
    day_ok = {d: day_totals[d] > 0 for d in sorted_days}
    return _count_consecutive_days(sorted_days, day_ok)


def compute_habit_streak(completions: Sequence[GoalCompletion]) -> int:
    """Compute current consecutive-day streak from in-memory completions.

    Used by ``GET /habits`` to populate streak without a per-goal DB query.
    """
    if not completions:
        return 0

    dates: set[date_type] = {_to_date(c.timestamp) for c in completions if c.completed_units > 0}

    if not dates:
        return 0

    sorted_dates = sorted(dates, reverse=True)
    day_ok = dict.fromkeys(sorted_dates, True)
    return _count_consecutive_days(sorted_dates, day_ok)


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
