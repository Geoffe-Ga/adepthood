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


async def _count_consecutive_streak(session: AsyncSession, goal_id: int, user_id: int) -> int:
    """Count consecutive completed check-ins for a goal, newest first."""
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
    current_streak = await _count_consecutive_streak(session, goal.id, current_user)
    new_streak, reason = update_streak(current_streak, payload.did_complete)

    completed_units = goal.target if payload.did_complete else 0
    session.add(
        GoalCompletion(
            goal_id=payload.goal_id, user_id=current_user, completed_units=completed_units
        )
    )
    await session.commit()

    reached, _ = achieved_milestones(new_streak, _DEFAULT_THRESHOLDS)
    return CheckInResult(
        streak=new_streak,
        milestones=[Milestone(threshold=t) for t in reached],
        reason_code=reason,
    )
