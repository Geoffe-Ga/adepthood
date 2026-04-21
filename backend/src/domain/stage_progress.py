"""Domain logic for computing stage progress and unlock status."""

from __future__ import annotations

from typing import cast

from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.constants import TOTAL_STAGES
from models.content_completion import ContentCompletion
from models.course_stage import CourseStage
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.practice import Practice
from models.practice_session import PracticeSession
from models.stage_content import StageContent
from models.stage_progress import StageProgress
from models.user_practice import UserPractice
from schemas.stage import HabitHistoryItem, PracticeHistoryItem

# Stage 1 is always unlocked regardless of progress state.
_STAGE_1 = 1

__all__ = [
    "TOTAL_STAGES",
    "AllStagesCompletedError",
    "compute_stage_progress",
    "get_stage_habit_history",
    "get_stage_practice_history",
    "get_user_progress",
    "get_user_progress_for_update",
    "is_stage_unlocked",
    "next_stage_for",
    "stage_exists",
]


class AllStagesCompletedError(Exception):
    """Raised by :func:`next_stage_for` when every stage is already completed.

    Keeping this as a plain domain exception — not ``HTTPException`` — lets
    non-HTTP callers (admin tooling, async tasks, tests) use the helper
    without pulling in FastAPI's transport layer.  Router code is responsible
    for catching this and mapping it to the appropriate HTTP response.
    """


async def get_user_progress(session: AsyncSession, user_id: int) -> StageProgress | None:
    """Fetch the StageProgress record for a user, or None."""
    result = await session.execute(select(StageProgress).where(StageProgress.user_id == user_id))
    return result.scalars().first()


async def get_user_progress_for_update(session: AsyncSession, user_id: int) -> StageProgress | None:
    """Fetch the StageProgress record with a ``FOR UPDATE`` row lock.

    Use this in mutation endpoints to prevent TOCTOU races (e.g. two
    concurrent advance requests both reading the same current_stage).
    The lock is held until the transaction commits or rolls back.
    """
    result = await session.execute(
        select(StageProgress).where(StageProgress.user_id == user_id).with_for_update()
    )
    return result.scalars().first()


def is_stage_unlocked(stage_number: int, progress: StageProgress | None) -> bool:
    """Determine if a stage is unlocked for the user.

    Stage 1 is always unlocked.  For stage N > 1, **every** prior stage must
    be in ``completed_stages`` — not just the immediate predecessor.  The
    single-predecessor shortcut (``(N-1) in completed_stages``) lets any
    admin tool, data import, or legacy row with a hole in the chain (e.g.
    ``[35]``) expose every intermediate stage it never actually completed.
    The chain check closes that gap without depending on the separate
    ``current_stage`` signal, which can drift out of sync with
    ``completed_stages`` independently.
    """
    if stage_number == _STAGE_1:
        return True
    if progress is None:
        return False
    required = set(range(1, stage_number))
    return required.issubset(set(progress.completed_stages or []))


def next_stage_for(progress: StageProgress | None) -> int:
    """Return the first unfinished stage for ``progress``.

    Fresh users (``progress is None``) start at stage 1.  Otherwise we take
    ``min({1..TOTAL_STAGES} - completed_stages)`` — the first *hole* in the
    completion set, not ``max(completed) + 1``.  The distinction matters for
    legacy rows like ``completed_stages=[1, 3]``: ``max+1`` would advance
    past stage 2 silently; ``min(missing)`` returns 2 and keeps the chain-
    validation invariant aligned with unlock-checking on dirty data.  Raises
    :class:`AllStagesCompletedError` when every stage is already completed
    so the caller cannot blindly advance past the curriculum.
    """
    if progress is None:
        return _STAGE_1
    completed = set(progress.completed_stages or [])
    missing = set(range(1, TOTAL_STAGES + 1)) - completed
    if not missing:
        raise AllStagesCompletedError
    return min(missing)


async def _compute_habits_progress(session: AsyncSession, user_id: int, stage_number: int) -> float:
    """Compute ratio of habits with ≥1 completion to total habits for a stage.

    Returns 0.0 when the user has no habits for this stage.
    """
    stage_str = str(stage_number)
    # Count total habits for this stage
    total_result = await session.execute(
        select(func.count())
        .select_from(Habit)
        .where(Habit.user_id == user_id, Habit.stage == stage_str)
    )
    total_habits: int = total_result.scalar() or 0
    if total_habits == 0:
        return 0.0

    # Count habits that have at least one GoalCompletion (via Goal)
    active_result = await session.execute(
        select(func.count(func.distinct(Habit.id)))
        .select_from(Habit)
        .join(Goal, col(Goal.habit_id) == col(Habit.id))
        .join(
            GoalCompletion,
            (col(GoalCompletion.goal_id) == col(Goal.id))
            & (col(GoalCompletion.user_id) == user_id),
        )
        .where(Habit.user_id == user_id, Habit.stage == stage_str)
    )
    active_habits: int = active_result.scalar() or 0
    return min(active_habits / total_habits, 1.0)


async def _compute_course_items_completed(
    session: AsyncSession, user_id: int, stage_number: int
) -> int:
    """Count content items completed by the user for a given stage."""
    result = await session.execute(
        select(func.count())
        .select_from(ContentCompletion)
        .join(StageContent, col(ContentCompletion.content_id) == col(StageContent.id))
        .join(CourseStage, col(StageContent.course_stage_id) == col(CourseStage.id))
        .where(
            ContentCompletion.user_id == user_id,
            CourseStage.stage_number == stage_number,
        )
    )
    return result.scalar() or 0


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

    habits_progress = await _compute_habits_progress(session, user_id, stage_number)
    course_items = await _compute_course_items_completed(session, user_id, stage_number)

    # Overall progress: simple average of available metrics
    total = habits_progress + (1.0 if practice_count > 0 else 0.0)
    divisor = 2
    overall = total / divisor if divisor > 0 else 0.0

    return {
        "habits_progress": round(habits_progress, 2),
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
