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
        day = ts.date() if hasattr(ts, "date") else date_type.fromisoformat(str(ts)[:10])
        day_totals[day] = day_totals.get(day, 0.0) + units

    sorted_days = sorted(day_totals, reverse=True)
    streak = 0
    for i, day in enumerate(sorted_days):
        if day_totals[day] <= 0:
            break
        if i > 0 and (sorted_days[i - 1] - day).days != 1:
            break
        streak += 1
    return streak


def compute_habit_streak(completions: Sequence[GoalCompletion]) -> int:
    """Compute current consecutive-day streak from in-memory completions.

    Used by ``GET /habits`` to populate streak without a per-goal DB query.
    Considers all goals' completions for one habit.
    """
    if not completions:
        return 0

    dates: set[date_type] = set()
    for c in completions:
        if c.completed_units > 0:
            ts = c.timestamp
            dates.add(ts.date() if hasattr(ts, "date") else date_type.fromisoformat(str(ts)[:10]))

    if not dates:
        return 0

    sorted_dates = sorted(dates, reverse=True)
    streak = 1
    for i in range(1, len(sorted_dates)):
        if (sorted_dates[i - 1] - sorted_dates[i]).days == 1:
            streak += 1
        else:
            break
    return streak


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
