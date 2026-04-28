"""Stage and stage progress API endpoints."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from domain.stage_progress import (
    AllStagesCompletedError,
    compute_stage_progress,
    get_stage_habit_history,
    get_stage_practice_history,
    get_user_progress,
    get_user_progress_for_update,
    is_stage_unlocked,
    next_stage_for,
    stage_exists,
)
from errors import bad_request, conflict, forbidden, not_found
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
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    pagination: Annotated[PaginationParams, Depends()],
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
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
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
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> StageProgressResponse:
    """Detailed progress breakdown for a stage."""
    if not await stage_exists(session, stage_number):
        raise not_found("stage")

    data = await compute_stage_progress(session, current_user, stage_number)
    return StageProgressResponse(**data)


@router.get("/{stage_number}/history", response_model=StageHistoryResponse)
async def get_stage_history(
    stage_number: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
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


def _bootstrap_record(existing: StageProgress) -> StageProgressRecord:
    """Build the ``StageProgressRecord`` for an idempotent bootstrap return."""
    return StageProgressRecord(
        id=existing.id,
        user_id=existing.user_id,
        current_stage=existing.current_stage,
        completed_stages=existing.completed_stages,
    )


def _is_bootstrap_state(existing: StageProgress) -> bool:
    """Return True when ``existing`` matches the freshly-created bootstrap row."""
    return existing.current_stage == 1 and not existing.completed_stages


async def _create_initial_progress(
    session: AsyncSession,
    user_id: int,
    payload: StageProgressUpdate,
) -> StageProgressRecord:
    """Handle the no-prior-row case: must assert stage 1, then create.

    Two concurrent first-advance requests for the same user could both
    read ``progress is None`` and both attempt to insert a fresh
    ``StageProgress`` row (BUG-STAGE-003).  The
    ``UniqueConstraint(user_id)`` on ``stageprogress`` rejects the
    second insert; we catch the ``IntegrityError``, re-fetch the
    winner under ``FOR UPDATE``, and return the same bootstrap record
    so the loser observes a consistent final state instead of
    surfacing as a 500.
    """
    if payload.current_stage != 1:
        raise bad_request("must_start_at_stage_one")
    progress = StageProgress(user_id=user_id, current_stage=1, completed_stages=[])
    session.add(progress)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        existing = await get_user_progress_for_update(session, user_id)
        if existing is None:
            # Defensive: the unique-constraint loser must see the
            # winner's row.  If it is gone the database state is
            # corrupt; surface 409 and preserve the original
            # ``IntegrityError`` chain so the constraint name + stack
            # reach Sentry / structured logs.
            raise conflict("stage_progress_race_unrecoverable") from exc
        if _is_bootstrap_state(existing):
            return _bootstrap_record(existing)
        # The winner already advanced past stage 1 — treat the loser's
        # payload as an advance-from-1 request and let the normal
        # derivation reject it with the appropriate 400 if the client
        # raced past stage 1 with a stale assertion.
        return await _advance_existing_progress(session, existing, payload)
    await session.refresh(progress)
    logger.info("stage_progress_started", extra={"user_id": user_id})
    return _bootstrap_record(progress)


def _derive_next_stage(existing: StageProgress) -> tuple[int, list[int]]:
    """Derive the server-expected next stage from ``existing``'s completion set.

    Simulates marking ``existing.current_stage`` complete on a detached copy so
    we can run :func:`next_stage_for` without mutating the tracked ORM row.
    """
    candidate_completed = sorted(set(existing.completed_stages or []) | {existing.current_stage})
    candidate = StageProgress(
        user_id=existing.user_id,
        current_stage=existing.current_stage,
        completed_stages=candidate_completed,
    )
    try:
        derived_next = next_stage_for(candidate)
    except AllStagesCompletedError as exc:
        raise conflict("all_stages_completed") from exc
    return derived_next, candidate_completed


async def _advance_existing_progress(
    session: AsyncSession,
    existing: StageProgress,
    payload: StageProgressUpdate,
) -> StageProgressRecord:
    """Validate the payload against the server-derived next stage, then commit."""
    derived_next, candidate_completed = _derive_next_stage(existing)
    if payload.current_stage != derived_next:
        raise bad_request("stage_advance_mismatch")

    existing.completed_stages = candidate_completed
    existing.current_stage = derived_next
    existing.stage_started_at = datetime.now(UTC)
    session.add(existing)
    await session.commit()
    await session.refresh(existing)
    logger.info(
        "stage_advanced",
        extra={"user_id": existing.user_id, "current_stage": existing.current_stage},
    )
    return StageProgressRecord(
        id=existing.id,
        user_id=existing.user_id,
        current_stage=existing.current_stage,
        completed_stages=existing.completed_stages,
    )


@router.put("/progress", response_model=StageProgressRecord)
async def update_progress(
    payload: StageProgressUpdate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> StageProgressRecord:
    """Advance the user to the next stage.

    The request body is treated as an **assertion** of what the client
    expects the new ``current_stage`` to be, not an authoritative write.
    The new state is derived server-side:

    - **Create** (no prior row): ``current_stage`` is forced to 1; the
      payload must assert 1 or it's rejected as ``must_start_at_stage_one``.
    - **Update**: the server marks ``existing.current_stage`` complete, then
      recomputes the new ``current_stage`` via :func:`next_stage_for` over
      the updated completion set.  The payload's ``current_stage`` must
      equal that derived value — otherwise the request is a skip/rewind/
      stale-client scenario and returns ``stage_advance_mismatch``.

    The ``completed_stages`` list is never read from the payload (the schema's
    ``extra='forbid'`` would 422 such a field anyway), so the client cannot
    mint credit for stages it hasn't actually completed.

    A ``SELECT … FOR UPDATE`` row-lock prevents two concurrent advance
    requests from both reading the same ``current_stage`` and passing the
    derivation check (TOCTOU race).

    BUG-STAGE-003: when several first-advance requests race, a winner
    that committed between two losers' SELECT and INSERT means one
    loser sees ``existing is None`` (handled inside
    :func:`_create_initial_progress`) and another sees the winner's
    bootstrap row.  Both losers must observe the same idempotent
    bootstrap response — so the ``payload.current_stage == 1`` +
    bootstrap-state check returns the existing row instead of trying to
    advance past it.

    Edge case: if the winner *also* finished a second advance (stage 1 →
    2) between two concurrent first-advance attempts, a loser arriving
    with ``payload.current_stage == 1`` against an ``existing`` already
    at stage 2 falls through to :func:`_advance_existing_progress` and
    is rejected with ``stage_advance_mismatch`` (400).  This is a
    deliberate non-idempotent outcome: the client's stale assertion no
    longer matches the server-derived next stage, and quietly returning
    an out-of-date bootstrap record would mask a real client / server
    drift.
    """
    existing = await get_user_progress_for_update(session, current_user)
    if existing is None:
        return await _create_initial_progress(session, current_user, payload)
    if payload.current_stage == 1 and _is_bootstrap_state(existing):
        return _bootstrap_record(existing)
    return await _advance_existing_progress(session, existing, payload)
