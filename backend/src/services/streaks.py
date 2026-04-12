"""Streak and milestone services — DB-aware wrappers over pure domain logic.

Routers call these helpers instead of computing streaks inline so the same
logic can be reused from background jobs, admin tools, and tests without
needing HTTP fixtures.  Pure functions stay in :mod:`domain.streaks` and
:mod:`domain.milestones` so they remain trivially unit-testable; this module
only adds the DB-query layer that composes them into a request-ready
result.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.milestones import achieved_milestones
from domain.streaks import update_streak
from models.goal_completion import GoalCompletion
from schemas.milestone import Milestone

__all__ = [
    "check_milestones",
    "compute_consecutive_streak",
    "update_streak",
]


async def compute_consecutive_streak(
    session: AsyncSession,
    goal_id: int,
    user_id: int,
) -> int:
    """Count consecutive completed check-ins for a goal, newest first.

    Scans :class:`GoalCompletion` rows for the goal in reverse-chronological
    order and counts rows where ``completed_units > 0`` until it hits a miss
    (or the end of history).  Returns ``0`` when the most recent check-in
    was a miss or when no history exists.
    """
    rows = await session.execute(
        select(GoalCompletion.completed_units)
        .where(GoalCompletion.goal_id == goal_id, GoalCompletion.user_id == user_id)
        .order_by(col(GoalCompletion.timestamp).desc())
    )
    streak = 0
    for (units,) in rows:
        if units > 0:
            streak += 1
        else:
            break
    return streak


def check_milestones(streak: int, thresholds: list[int]) -> list[Milestone]:
    """Return the :class:`Milestone` objects reached by ``streak``.

    Wraps :func:`domain.milestones.achieved_milestones` so callers that want
    response-ready DTOs do not have to map the raw ``list[int]`` themselves.
    The underlying domain function stays pure and is still used directly by
    tests that only care about thresholds.
    """
    reached, _reason = achieved_milestones(streak, thresholds)
    return [Milestone(threshold=t) for t in reached]
