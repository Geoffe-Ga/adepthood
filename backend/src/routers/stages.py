"""Stage and stage progress API endpoints."""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from domain.stage_progress import (
    compute_stage_progress,
    get_stage_habit_history,
    get_stage_practice_history,
    get_user_progress,
    get_user_progress_for_update,
    is_stage_unlocked,
    stage_exists,
)
from errors import bad_request, forbidden, not_found
from models.course_stage import CourseStage
from models.stage_progress import StageProgress
from routers.auth import get_current_user
from schemas import Page, PaginationParams, build_page
from schemas.pagination import paginate_query
from schemas.stage import (
    StageHistoryResponse,
    StageProgressRecord,
    StageProgressResponse,
    StageProgressUpdate,
    StageResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/stages", tags=["stages"])


async def _build_stage_response(
    stage: CourseStage,
    session: AsyncSession,
    user_id: int,
    progress: StageProgress | None,
) -> StageResponse:
    """Assemble a :class:`StageResponse` with the current user's progress overlay."""
    unlocked = is_stage_unlocked(stage.stage_number, progress)
    stage_progress = 0.0
    if unlocked:
        data = await compute_stage_progress(session, user_id, stage.stage_number)
        stage_progress = data["overall_progress"]
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
        is_unlocked=unlocked,
        progress=float(stage_progress),
    )


@router.get("", response_model=None)
async def list_stages(
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
    pagination: PaginationParams = Depends(),  # noqa: B008
) -> Page[StageResponse] | list[StageResponse]:
    """List all stages with per-user progress overlay.

    Each stage's ``progress`` field is populated from
    ``compute_stage_progress`` so the frontend can render progress bars
    without a follow-up call. This accepts an N+M round-trip (one query
    per metric per stage) since N=10 stages is small and caching would
    add complexity disproportionate to the benefit.

    BUG-INFRA-016: returns ``Page[StageResponse]`` when ``?paginate=true``
    is set; otherwise the legacy bare list is returned for one release while
    the frontend migrates to the envelope.
    """
    query = select(CourseStage).order_by(col(CourseStage.stage_number).asc())
    stages, total = await paginate_query(session, query, pagination)
    progress = await get_user_progress(session, current_user)

    responses = [await _build_stage_response(s, session, current_user, progress) for s in stages]

    if pagination.paginate:
        return build_page(responses, total, pagination)
    return responses


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


@router.get("/{stage_number}/history", response_model=StageHistoryResponse)
async def get_stage_history(
    stage_number: int,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> StageHistoryResponse:
    """Aggregated practice and habit history for a stage."""
    if not await stage_exists(session, stage_number):
        raise not_found("stage")

    progress = await get_user_progress(session, current_user)
    if not is_stage_unlocked(stage_number, progress):
        raise forbidden("stage_locked")

    practices = await get_stage_practice_history(session, current_user, stage_number)
    habits = await get_stage_habit_history(session, current_user, stage_number)

    return StageHistoryResponse(
        stage_number=stage_number,
        practices=practices,
        habits=habits,
    )


@router.put("/progress", response_model=StageProgressRecord)
async def update_progress(
    payload: StageProgressUpdate,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> StageProgressRecord:
    """Advance the user to the next stage.

    Semantics:
    - **Create** (first ever progress): ``current_stage`` must be 1.
    - **Update**: ``current_stage`` must equal ``existing.current_stage + 1``
      (single-step forward only — no stage-skipping).
    - ``completed_stages`` is always ``range(1, current_stage)`` — i.e. every
      stage before the current one is marked complete.

    A ``SELECT … FOR UPDATE`` row-lock prevents two concurrent advance
    requests from both reading the same ``current_stage`` and passing the
    forward-only check (TOCTOU race).
    """
    # Row lock prevents concurrent advances from both reading the same state
    existing = await get_user_progress_for_update(session, current_user)

    if existing is not None:
        expected_next = existing.current_stage + 1
        if payload.current_stage != expected_next:
            raise bad_request("must_advance_one_stage")
        completed = list(range(1, payload.current_stage))
        existing.current_stage = payload.current_stage
        existing.completed_stages = completed
        existing.stage_started_at = datetime.now(UTC)
        session.add(existing)
        await session.commit()
        await session.refresh(existing)
        logger.info(
            "stage_advanced",
            extra={"user_id": current_user, "current_stage": existing.current_stage},
        )
        return StageProgressRecord(
            id=existing.id,
            user_id=existing.user_id,
            current_stage=existing.current_stage,
            completed_stages=existing.completed_stages,
        )

    if payload.current_stage != 1:
        raise bad_request("must_start_at_stage_one")

    progress = StageProgress(
        user_id=current_user,
        current_stage=1,
        completed_stages=[],
    )
    session.add(progress)
    await session.commit()
    await session.refresh(progress)
    logger.info("stage_progress_started", extra={"user_id": current_user})
    return StageProgressRecord(
        id=progress.id,
        user_id=progress.user_id,
        current_stage=progress.current_stage,
        completed_stages=progress.completed_stages,
    )
