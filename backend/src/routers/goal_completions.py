"""Goal completion API endpoints backed by the database."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from domain.milestones import achieved_milestones
from domain.streaks import update_streak
from errors import forbidden, not_found
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from routers.auth import get_current_user
from schemas import CheckInResult, Milestone

router = APIRouter(prefix="/goal_completions", tags=["goals"])

_DEFAULT_THRESHOLDS = [1, 3, 7, 14, 30]


class GoalCompletionRequest(BaseModel):
    """Payload for recording a goal completion or miss."""

    goal_id: int
    did_complete: bool = True


@router.post("/", response_model=CheckInResult)
async def create_goal_completion(
    payload: GoalCompletionRequest,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> CheckInResult:
    """Record a check-in and return updated streak and milestones."""
    goal = await session.get(Goal, payload.goal_id)
    if goal is None:
        raise not_found("goal")

    habit = await session.get(Habit, goal.habit_id)
    if habit is None or habit.user_id != current_user:
        raise forbidden("not_owner")

    # Compute current streak from consecutive completions (newest first)
    assert goal.id is not None
    rows = await session.execute(
        select(GoalCompletion.completed_units)
        .where(GoalCompletion.goal_id == goal.id, GoalCompletion.user_id == current_user)
        .order_by(col(GoalCompletion.timestamp).desc())
    )
    current_streak = 0
    for (units,) in rows:
        if units > 0:
            current_streak += 1
        else:
            break

    new_streak, reason = update_streak(current_streak, payload.did_complete)

    session.add(
        GoalCompletion(
            goal_id=payload.goal_id,
            user_id=current_user,
            completed_units=goal.target if payload.did_complete else 0,
        )
    )
    await session.commit()

    reached, _ = achieved_milestones(new_streak, _DEFAULT_THRESHOLDS)
    milestones = [Milestone(threshold=t) for t in reached]
    return CheckInResult(streak=new_streak, milestones=milestones, reason_code=reason)
