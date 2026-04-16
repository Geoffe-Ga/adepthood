"""Goal completion API endpoints backed by the database."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from errors import forbidden, not_found
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from routers.auth import get_current_user
from schemas import CheckInResult
from services.streaks import check_milestones, compute_consecutive_streak, update_streak

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/goal_completions", tags=["goals"])

# Streak milestones surfaced on check-in responses.  Kept as a module constant
# so both the router and future background jobs share the same thresholds.
_DEFAULT_THRESHOLDS = [1, 3, 7, 14, 30]


class GoalCompletionRequest(BaseModel):
    """Payload for recording a goal completion or miss."""

    goal_id: int
    did_complete: bool = True


async def _get_owned_goal(session: AsyncSession, goal_id: int, user_id: int) -> Goal:
    """Fetch a goal and verify ownership through its parent habit."""
    goal = await session.get(Goal, goal_id)
    if goal is None:
        raise not_found("goal")

    habit = await session.get(Habit, goal.habit_id)
    if habit is None:
        raise forbidden("not_owner")
    if habit.user_id != user_id:
        raise forbidden("not_owner")

    return goal


@router.post("/", response_model=CheckInResult)
async def create_goal_completion(
    payload: GoalCompletionRequest,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> CheckInResult:
    """Record a check-in and return updated streak and milestones."""
    goal = await _get_owned_goal(session, payload.goal_id, current_user)

    assert goal.id is not None
    current_streak = await compute_consecutive_streak(session, goal.id, current_user)
    new_streak, reason = update_streak(current_streak, payload.did_complete)

    completed_units = goal.target if payload.did_complete else 0
    session.add(
        GoalCompletion(
            goal_id=payload.goal_id, user_id=current_user, completed_units=completed_units
        )
    )
    await session.commit()

    logger.info(
        "goal_completion_recorded",
        extra={
            "user_id": current_user,
            "goal_id": payload.goal_id,
            "did_complete": payload.did_complete,
            "streak": new_streak,
        },
    )

    return CheckInResult(
        streak=new_streak,
        milestones=check_milestones(new_streak, _DEFAULT_THRESHOLDS),
        reason_code=reason,
    )
