"""Domain logic for computing stage progress and unlock status."""

from __future__ import annotations

from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.course_stage import CourseStage
from models.practice_session import PracticeSession
from models.stage_progress import StageProgress

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
    # Count practice sessions for this stage
    ps_result = await session.execute(
        select(func.count()).where(
            PracticeSession.user_id == user_id,
            PracticeSession.stage_number == stage_number,
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
