"""Domain logic for computing stage progress and unlock status."""

from __future__ import annotations

from typing import cast

from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.course_stage import CourseStage
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.practice import Practice
from models.practice_session import PracticeSession
from models.stage_progress import StageProgress
from models.user_practice import UserPractice
from schemas.stage import HabitHistoryItem, PracticeHistoryItem

# Stage N+1 unlocks when stage N is in completed_stages or is the current stage
_STAGE_1 = 1


async def get_user_progress(session: AsyncSession, user_id: int) -> StageProgress | None:
    """Fetch the StageProgress record for a user, or None."""
    result = await session.execute(select(StageProgress).where(StageProgress.user_id == user_id))
    return result.scalars().first()


def is_stage_unlocked(stage_number: int, progress: StageProgress | None) -> bool:
    """Determine if a stage is unlocked for the user."""
    if stage_number == _STAGE_1:
        return True
    if progress is None:
        return False
    if stage_number <= progress.current_stage:
        return True
    return stage_number - 1 in (progress.completed_stages or [])


async def compute_stage_progress(
    session: AsyncSession,
    user_id: int,
    stage_number: int,
) -> dict[str, float | int]:
    """Compute detailed progress for a user in a specific stage."""
    # Count practice sessions for this stage (join through UserPractice)
    ps_result = await session.execute(
        select(func.count())
        .select_from(PracticeSession)
        .join(UserPractice, col(PracticeSession.user_practice_id) == col(UserPractice.id))
        .where(
            PracticeSession.user_id == user_id,
            UserPractice.stage_number == stage_number,
        )
    )
    practice_count: int = ps_result.scalar() or 0

    # Count habits for this stage (habits have a stage field matching stage name)
    # For now, habits_progress is 0.0 as it requires goal completion analysis
    habits_progress = 0.0

    # Course items completed — will be implemented with StageContent tracking
    course_items = 0

    # Overall progress: simple average of available metrics
    total = habits_progress + (1.0 if practice_count > 0 else 0.0)
    divisor = 2
    overall = total / divisor if divisor > 0 else 0.0

    return {
        "habits_progress": habits_progress,
        "practice_sessions_completed": practice_count,
        "course_items_completed": course_items,
        "overall_progress": round(overall, 2),
    }


async def stage_exists(session: AsyncSession, stage_number: int) -> bool:
    """Check if a stage with the given number exists."""
    result = await session.execute(
        select(CourseStage).where(CourseStage.stage_number == stage_number)
    )
    return result.scalars().first() is not None


async def get_stage_practice_history(
    session: AsyncSession,
    user_id: int,
    stage_number: int,
) -> list[PracticeHistoryItem]:
    """Aggregate practice session history for a user in a specific stage."""
    # Get all user-practices for this stage, joined with Practice for names
    result = await session.execute(
        select(
            Practice.name,
            func.count(col(PracticeSession.id)).label("sessions_completed"),
            func.coalesce(func.sum(PracticeSession.duration_minutes), 0).label("total_minutes"),
            func.max(PracticeSession.timestamp).label("last_session"),
        )
        .select_from(PracticeSession)
        .join(UserPractice, col(PracticeSession.user_practice_id) == col(UserPractice.id))
        .join(Practice, col(UserPractice.practice_id) == col(Practice.id))
        .where(
            PracticeSession.user_id == user_id,
            UserPractice.stage_number == stage_number,
        )
        .group_by(Practice.name)
    )
    rows = result.all()
    return [
        PracticeHistoryItem(
            name=row.name,
            sessions_completed=row.sessions_completed,
            total_minutes=float(row.total_minutes),
            last_session=row.last_session,
        )
        for row in rows
    ]


async def _fetch_stage_habits(
    session: AsyncSession, user_id: int, stage_number: int
) -> list[Habit]:
    """Return the user's habits for a stage, ordered by id for deterministic output."""
    stage_str = str(stage_number)
    result = await session.execute(
        select(Habit)
        .where(Habit.user_id == user_id, Habit.stage == stage_str)
        .order_by(col(Habit.id).asc())
    )
    return list(result.scalars().all())


async def _fetch_goal_completion_stats(
    session: AsyncSession, user_id: int, habit_ids: list[int]
) -> dict[int, dict[str, int]]:
    """Return ``{habit_id: {tier: completion_count}}`` in a single JOIN query.

    A LEFT OUTER JOIN keeps goals without any completions in the result set,
    so callers can still mark their tier as ``False``. The user filter is on
    the join condition (not the WHERE clause) so a goal with only *other*
    users' completions still surfaces with ``count == 0``.
    """
    if not habit_ids:
        return {}

    result = await session.execute(
        select(
            Goal.habit_id,
            Goal.tier,
            func.count(col(GoalCompletion.id)).label("completion_count"),
        )
        .select_from(Goal)
        .outerjoin(
            GoalCompletion,
            (col(GoalCompletion.goal_id) == col(Goal.id))
            & (col(GoalCompletion.user_id) == user_id),
        )
        .where(col(Goal.habit_id).in_(habit_ids))
        .group_by(col(Goal.habit_id), col(Goal.tier))
    )

    stats: dict[int, dict[str, int]] = {hid: {} for hid in habit_ids}
    for row in result.all():
        stats[row.habit_id][row.tier] = int(row.completion_count or 0)
    return stats


def _build_history_item(habit: Habit, tier_counts: dict[str, int]) -> HabitHistoryItem:
    """Roll a habit's per-tier completion counts up into a history item."""
    return HabitHistoryItem(
        name=habit.name,
        icon=habit.icon,
        goals_achieved={tier: count > 0 for tier, count in tier_counts.items()},
        best_streak=habit.streak,
        total_completions=sum(tier_counts.values()),
    )


async def get_stage_habit_history(
    session: AsyncSession,
    user_id: int,
    stage_number: int,
) -> list[HabitHistoryItem]:
    """Aggregate habit and goal history for a user in a specific stage.

    Habits are matched by their ``stage`` field against the stage_number
    (converted to string). The previous implementation issued one query per
    habit *and* one per goal, scaling as ``1 + 2*habits + goals`` queries
    (26+ queries for a typical stage). This implementation collapses the work
    into two queries regardless of habit/goal count: one to fetch the habits,
    and one JOIN-aggregate to count completions per (habit, tier).
    """
    habits = await _fetch_stage_habits(session, user_id, stage_number)
    # Habits returned by SELECT always have a primary key assigned; the cast is
    # a static-typing hint, not a runtime guard, so it costs nothing here.
    habit_ids = [cast("int", h.id) for h in habits]
    stats_by_habit = await _fetch_goal_completion_stats(session, user_id, habit_ids)
    return [_build_history_item(h, stats_by_habit.get(cast("int", h.id), {})) for h in habits]
