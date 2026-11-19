"""Authorized, uncached whole-person series.

The read never provisions a progress row. Its one write is settling: a pending
pass whose day has come is opened (and committed) before the series are read,
as every other "person is present" reader does (issue #3725).
"""

from collections import defaultdict
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from dependencies.timezone import current_user_timezone
from domain.dates import today_in_tz
from domain.pass_rescaffold import settle_pending_pass
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
from models.habit_unlock_event import HabitUnlockEvent
from models.metta_return_arc import MettaReturnArc
from models.practice import Practice
from models.practice_session import PracticeSession
from models.program_pass import ProgramPass
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


async def _passes(session: AsyncSession, owner: int) -> Sequence[ProgramPass]:
    """The owner's recorded passes, oldest first, in one query."""
    result = await session.execute(
        select(ProgramPass)
        .where(ProgramPass.user_id == owner)
        .order_by(col(ProgramPass.pass_number))
    )
    return result.scalars().all()


async def _unlock_events(session: AsyncSession, owner: int) -> Sequence[HabitUnlockEvent]:
    """The owner's unlock-log rows in the owner's own passes on the owner's own habits.

    One query however many habits. The inner join on the pass also drops a row
    with no pass, which is never drawn (issue #3726).
    """
    result = await session.execute(
        select(HabitUnlockEvent)
        .join(ProgramPass, col(HabitUnlockEvent.pass_id) == col(ProgramPass.id))
        .join(Habit, col(HabitUnlockEvent.habit_id) == col(Habit.id))
        .where(
            HabitUnlockEvent.user_id == owner,
            ProgramPass.user_id == owner,
            Habit.user_id == owner,
        )
        .order_by(col(HabitUnlockEvent.occurred_at), col(HabitUnlockEvent.id))
    )
    return result.scalars().all()


async def _return_arcs(session: AsyncSession, owner: int) -> Sequence[MettaReturnArc]:
    """The owner's Metta Return arcs, oldest first, in one query (issue #3745).

    The pass each arc sits in is read from the owner's own passes, already
    loaded by :func:`_passes`, so no join reaches another account's rows.
    """
    result = await session.execute(
        select(MettaReturnArc)
        .where(MettaReturnArc.user_id == owner)
        .order_by(col(MettaReturnArc.started_at), col(MettaReturnArc.id))
    )
    return result.scalars().all()


async def _settled_progress(
    session: AsyncSession, owner: int, timezone: str
) -> StageProgress | None:
    """The owner's progress row, with a pending pass whose day has come opened first.

    Reading the overview is someone showing up, as the Map, Course and habit
    list reads are (issue #3725), so the pass rows read next are current.
    """
    progress = (
        await session.execute(select(StageProgress).where(StageProgress.user_id == owner))
    ).scalar_one_or_none()
    if progress is None:
        return None
    return await settle_pending_pass(session, progress, tz=timezone)


async def _read_values(session: AsyncSession, owner: int, timezone: str) -> OverviewInput:
    """Bulk-load every owner boundary, including both sides of session adoptions."""
    progress = await _settled_progress(session, owner, timezone)
    preferences = (
        await session.execute(
            select(UserDepthPreferences).where(UserDepthPreferences.user_id == owner)
        )
    ).scalar_one_or_none()
    habits = (
        (
            await session.execute(
                select(Habit)
                .where(Habit.user_id == owner)
                # The order GET /habits serves, so this screen lists habits the
                # way the Habits screen does: arranged slot first (unnumbered
                # legacy rows ahead of numbered ones), id only as the tie-break.
                .order_by(col(Habit.sort_order).asc().nulls_first(), col(Habit.id))
            )
        )
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
        now=datetime.now(UTC),
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
        passes=await _passes(session, owner),
        unlock_events=await _unlock_events(session, owner),
        return_arcs=await _return_arcs(session, owner),
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
