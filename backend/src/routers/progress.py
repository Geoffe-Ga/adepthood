"""Authorized, uncached whole-person series without provisioning side effects."""

from collections import defaultdict
from collections.abc import Sequence
from typing import Annotated

from fastapi import Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from dependencies.timezone import current_user_timezone
from domain.dates import today_in_tz
from domain.progress_overview import (
    OverviewHabitContext,
    OverviewInput,
    build_progress_overview,
    minimum_goal,
)
from domain.wheel import aspect_labels_by_stage
from error_responses import build_router
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.practice import Practice
from models.practice_session import PracticeSession
from models.stage_progress import StageProgress
from models.user_depth_preferences import UserDepthPreferences
from models.user_practice import UserPractice
from routers.auth import get_current_user
from schemas.progress import ProgressOverviewResponse
from seed_practices import STAGE_TO_PRESET_NAME
from services.streaks import period_cadence_for_goals, subtractive_context_for_goals

router = build_router(prefix="/progress", tags=["progress"])


def _goals_by_habit(goals: Sequence[Goal]) -> dict[int, list[Goal]]:
    """Group the bulk authorized goal read without per-habit queries."""
    result: dict[int, list[Goal]] = defaultdict(list)
    for goal in goals:
        result[goal.habit_id].append(goal)
    return result


def _habit_contexts(
    habits: Sequence[Habit], goals: Sequence[Goal]
) -> dict[int, OverviewHabitContext]:
    """Apply the canonical cadence/polarity owners at the value-only boundary.

    The canonical context owns the bucket and habit-level polarity. The pure
    domain scores each named tier's own effective target, without assuming
    that single-goal edits preserve their effective difficulty ordering.
    """
    by_habit = _goals_by_habit(goals)
    result = {}
    for habit in habits:
        if habit.id is None:
            continue
        siblings = by_habit[habit.id]
        low = minimum_goal(siblings)
        if low is not None:
            result[habit.id] = OverviewHabitContext(
                cadence=period_cadence_for_goals(siblings, habit.start_date),
                subtractive=subtractive_context_for_goals(siblings, habit.start_date) is not None,
            )
    return result


async def _practice_asks(session: AsyncSession) -> dict[int, float]:
    """Only approved system rows matching the canonical preset can name an ask."""
    result = await session.execute(
        select(Practice).where(
            col(Practice.submitted_by_user_id).is_(None),
            col(Practice.approved).is_(True),
            col(Practice.name).in_(STAGE_TO_PRESET_NAME.values()),
        )
    )
    return {
        practice.stage_number: practice.default_duration_minutes
        for practice in result.scalars().all()
        if STAGE_TO_PRESET_NAME.get(practice.stage_number) == practice.name
    }


async def _read_values(session: AsyncSession, owner: int, timezone: str) -> OverviewInput:
    """Bulk-load every owner boundary, including both sides of session adoptions."""
    progress = (
        await session.execute(select(StageProgress).where(StageProgress.user_id == owner))
    ).scalar_one_or_none()
    preferences = (
        await session.execute(
            select(UserDepthPreferences).where(UserDepthPreferences.user_id == owner)
        )
    ).scalar_one_or_none()
    habits = (
        (await session.execute(select(Habit).where(Habit.user_id == owner).order_by(col(Habit.id))))
        .scalars()
        .all()
    )
    goals = (
        (
            await session.execute(
                select(Goal)
                .join(Habit, col(Goal.habit_id) == col(Habit.id))
                .where(Habit.user_id == owner)
                .order_by(col(Goal.id))
            )
        )
        .scalars()
        .all()
    )
    completions = (
        (
            await session.execute(
                select(GoalCompletion)
                .join(Goal, col(GoalCompletion.goal_id) == col(Goal.id))
                .join(Habit, col(Goal.habit_id) == col(Habit.id))
                .where(GoalCompletion.user_id == owner, Habit.user_id == owner)
            )
        )
        .scalars()
        .all()
    )
    sits = (
        (
            await session.execute(
                select(PracticeSession)
                .join(UserPractice, col(PracticeSession.user_practice_id) == col(UserPractice.id))
                .where(PracticeSession.user_id == owner, UserPractice.user_id == owner)
            )
        )
        .scalars()
        .all()
    )
    return OverviewInput(
        today=today_in_tz(timezone),
        timezone=timezone,
        progress=progress,
        habits=habits,
        goals=goals,
        completions=completions,
        practice_sessions=sits,
        aspects=await aspect_labels_by_stage(session, list(STAGE_TO_PRESET_NAME)),
        practice_asks=await _practice_asks(session),
        habit_contexts=_habit_contexts(habits, goals),
        enable_habits=preferences.enable_habits if preferences else True,
        enable_practices=preferences.enable_practices if preferences else True,
    )


@router.get("/overview", response_model=ProgressOverviewResponse)
async def get_progress_overview(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
    response: Response,
) -> ProgressOverviewResponse:
    """Return the user's optional trajectory using only persisted known anchors."""
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Vary"] = "Authorization"
    return build_progress_overview(await _read_values(session, current_user, user_tz))
