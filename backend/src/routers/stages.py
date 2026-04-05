"""Stage and stage progress API endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from domain.stage_progress import (
    compute_stage_progress,
    get_user_progress,
    is_stage_unlocked,
    stage_exists,
)
from errors import bad_request, not_found
from models.course_stage import CourseStage
from models.stage_progress import StageProgress
from routers.auth import get_current_user
from schemas.stage import (
    StageProgressRecord,
    StageProgressResponse,
    StageProgressUpdate,
    StageResponse,
)

router = APIRouter(prefix="/stages", tags=["stages"])


@router.get("", response_model=list[StageResponse])
async def list_stages(
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> list[StageResponse]:
    """List all stages with per-user progress overlay."""
    result = await session.execute(
        select(CourseStage).order_by(col(CourseStage.stage_number).asc())
    )
    stages = result.scalars().all()
    progress = await get_user_progress(session, current_user)

    return [
        StageResponse(
            id=s.id,
            title=s.title,
            subtitle=s.subtitle,
            stage_number=s.stage_number,
            overview_url=s.overview_url,
            category=s.category,
            aspect=s.aspect,
            spiral_dynamics_color=s.spiral_dynamics_color,
            growing_up_stage=s.growing_up_stage,
            divine_gender_polarity=s.divine_gender_polarity,
            relationship_to_free_will=s.relationship_to_free_will,
            free_will_description=s.free_will_description,
            is_unlocked=is_stage_unlocked(s.stage_number, progress),
        )
        for s in stages
    ]


@router.get("/{stage_number}", response_model=StageResponse)
async def get_stage(
    stage_number: int,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> StageResponse:
    """Get a single stage with full metadata and progress."""
    result = await session.execute(
        select(CourseStage).where(CourseStage.stage_number == stage_number)
    )
    stage = result.scalars().first()
    if stage is None:
        raise not_found("stage")

    progress = await get_user_progress(session, current_user)
    return StageResponse(
        id=stage.id,
        title=stage.title,
        subtitle=stage.subtitle,
        stage_number=stage.stage_number,
        overview_url=stage.overview_url,
        category=stage.category,
        aspect=stage.aspect,
        spiral_dynamics_color=stage.spiral_dynamics_color,
        growing_up_stage=stage.growing_up_stage,
        divine_gender_polarity=stage.divine_gender_polarity,
        relationship_to_free_will=stage.relationship_to_free_will,
        free_will_description=stage.free_will_description,
        is_unlocked=is_stage_unlocked(stage.stage_number, progress),
    )


@router.get("/{stage_number}/progress", response_model=StageProgressResponse)
async def get_stage_progress(
    stage_number: int,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> StageProgressResponse:
    """Detailed progress breakdown for a stage."""
    if not await stage_exists(session, stage_number):
        raise not_found("stage")

    data = await compute_stage_progress(session, current_user, stage_number)
    return StageProgressResponse(**data)


@router.put("/progress", response_model=StageProgressRecord)
async def update_progress(
    payload: StageProgressUpdate,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> StageProgressRecord:
    """Update the user's current stage (advance forward)."""
    existing = await get_user_progress(session, current_user)

    if existing is not None:
        if payload.current_stage <= existing.current_stage:
            raise bad_request("cannot_go_backwards")
        # Mark all stages before the new current as completed
        completed = list(range(1, payload.current_stage))
        existing.current_stage = payload.current_stage
        existing.completed_stages = completed
        session.add(existing)
        await session.commit()
        await session.refresh(existing)
        return StageProgressRecord(
            id=existing.id,
            user_id=existing.user_id,
            current_stage=existing.current_stage,
            completed_stages=existing.completed_stages,
        )

    progress = StageProgress(
        user_id=current_user,
        current_stage=payload.current_stage,
        completed_stages=list(range(1, payload.current_stage)),
    )
    session.add(progress)
    await session.commit()
    await session.refresh(progress)
    return StageProgressRecord(
        id=progress.id,
        user_id=progress.user_id,
        current_stage=progress.current_stage,
        completed_stages=progress.completed_stages,
    )
