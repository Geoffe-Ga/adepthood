"""Stage and stage progress API endpoints."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from bounds import StageNumberPath
from curriculum import CurriculumDataError, stage_curriculum
from database import get_session
from dependencies.creek_vault import get_creek_vault_client
from dependencies.timezone import current_user_timezone
from domain.constants import TOTAL_STAGES
from domain.creek_vault import CreekVaultClient
from domain.program_calendar import calendar_stage, calendar_week, resolve_program_anchor
from domain.stage_authority import record_stage_entry
from domain.stage_progress import (
    compute_stage_progress,
    compute_stage_progress_batch,
    get_stage_habit_history,
    get_stage_practice_history,
    get_user_progress,
    get_user_progress_for_update,
    is_stage_unlocked,
    stage_exists,
)
from error_responses import build_router
from errors import conflict, forbidden, not_found
from models.course_stage import CourseStage
from models.stage_progress import StageProgress
from routers.auth import get_current_user
from schemas import Page, PaginationParams, build_page
from schemas.pagination import paginate_query
from schemas.stage import (
    ProgramCalendarResponse,
    StageExpression,
    StageHistoryResponse,
    StageManifestation,
    StageProgressRecord,
    StageProgressResponse,
    StageResponse,
)
from schemas.wheel import WheelAspect, WheelBalanceResponse
from services.creek_vault_wheel import select_wheel_balance

logger = logging.getLogger(__name__)

router = build_router(prefix="/stages", tags=["stages"], extra_statuses=(status.HTTP_409_CONFLICT,))


def _stage_manifestations(stage_number: int) -> list[StageManifestation]:
    """Return a stage's phase manifestations from the cached curriculum loader."""
    try:
        stage = stage_curriculum(stage_number)
    except CurriculumDataError:
        return []
    return [
        StageManifestation(
            phase=m.phase.value,
            integrated=StageExpression(
                name=m.integrated.name, description=m.integrated.description
            ),
            shadow=StageExpression(name=m.shadow.name, description=m.shadow.description),
        )
        for m in stage.manifestations
    ]


def _build_stage_response(
    stage: CourseStage,
    stage_progress: float,
    *,
    unlocked: bool,
) -> StageResponse:
    """Assemble a :class:`StageResponse` from a precomputed progress value.

    Progress is computed in one batched pass by the caller (issue #473) rather
    than per stage, so this stays a pure, query-free assembler.
    """
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
        manifestations=_stage_manifestations(stage.stage_number),
    )


def _overlay_stage(
    stage: CourseStage,
    unlocked: dict[int, bool],
    batch: dict[int, dict[str, float | int]],
) -> StageResponse:
    """Assemble one stage response, reading its progress from the batch (0.0 if locked)."""
    is_open = unlocked[stage.stage_number]
    value = batch[stage.stage_number]["overall_progress"] if is_open else 0.0
    return _build_stage_response(stage, value, unlocked=is_open)


async def _stage_responses_with_progress(
    session: AsyncSession,
    user_id: int,
    stages: list[CourseStage],
    tz: str,
) -> list[StageResponse]:
    """Overlay batched progress onto a page of stages (issue #473).

    Computes unlock state once, batches progress for the unlocked stages in
    three grouped queries, then assembles a response per stage. Locked stages
    report ``0.0`` without entering the batch.
    """
    progress = await get_user_progress(session, user_id)
    unlocked = {s.stage_number: is_stage_unlocked(s.stage_number, progress, tz=tz) for s in stages}
    unlocked_numbers = [n for n, ok in unlocked.items() if ok]
    batch = await compute_stage_progress_batch(session, user_id, unlocked_numbers)
    return [_overlay_stage(s, unlocked, batch) for s in stages]


async def _record_visit(session: AsyncSession, user_id: int, tz: str) -> StageProgress | None:
    """Note that the caller showed up, returning their (possibly advanced) row.

    Reading the Map is how someone shows up inside the program, so it is where
    :func:`domain.stage_authority.record_stage_entry` runs: entry into a window
    the calendar has already opened is recorded here, server-side, with nobody
    asking for it. A user with no progress row yet is left alone — these are
    read endpoints and provisioning a row is the course's job, not the Map's.
    """
    progress = await get_user_progress(session, user_id)
    if progress is None:
        return None
    return await record_stage_entry(session, progress, tz=tz)


@router.get("", response_model=None)
async def list_stages(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
    pagination: Annotated[PaginationParams, Depends()],
) -> Page[StageResponse] | list[StageResponse]:
    """List all stages with per-user progress overlay.

    Each stage's ``progress`` field is populated from
    ``compute_stage_progress_batch`` — three grouped queries for the whole
    list regardless of stage count — so the frontend can render progress bars
    without a follow-up call and the endpoint no longer scales N-by-M with
    course length (issue #473). Only unlocked stages feed the batch; locked
    stages report ``0.0`` progress as before.

    BUG-INFRA-016: returns ``Page[StageResponse]`` when ``?paginate=true``
    is set; otherwise the legacy bare list is returned for one release while
    the frontend migrates to the envelope.

    Listing the stages is a visit, so it records entry into whatever window
    the calendar has opened before the unlock overlay is computed.
    """
    await _record_visit(session, current_user, user_tz)
    query = select(CourseStage).order_by(col(CourseStage.stage_number).asc())
    stages, total = await paginate_query(session, query, pagination)
    responses = await _stage_responses_with_progress(session, current_user, stages, user_tz)

    if pagination.paginate:
        return build_page(responses, total, pagination)
    return responses


@router.get("/program-calendar", response_model=ProgramCalendarResponse)
async def get_program_calendar(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> ProgramCalendarResponse:
    """The server's view of the date-derived program calendar.

    Registered ABOVE ``/{stage_number}`` so the static path wins route
    matching.  A user with no progress row yet sees the day-zero shape.

    Asking where the calendar has got to is a visit, so ``current_stage`` in
    the response is the record *after* entry has been noted: someone who has
    been away for two months reads back the stage they have just walked into,
    not the one they left.
    """
    progress = await _record_visit(session, current_user, user_tz)
    if progress is None:
        return ProgramCalendarResponse(
            program_started_at=None,
            calendar_stage=1,
            calendar_week=1,
            current_stage=1,
            cycle_number=1,
        )
    anchor = resolve_program_anchor(progress)
    return ProgramCalendarResponse(
        program_started_at=anchor,
        calendar_stage=calendar_stage(anchor, tz=user_tz),
        calendar_week=calendar_week(anchor, tz=user_tz),
        current_stage=progress.current_stage,
        cycle_number=progress.cycle_number,
    )


@router.get("/wheel", response_model=WheelBalanceResponse)
async def get_wheel_balance(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    vault_client: Annotated[CreekVaultClient, Depends(get_creek_vault_client)],
) -> WheelBalanceResponse:
    """Per-Aspect fullness for all ten stages, in canonical stage order.

    Registered ABOVE ``/{stage_number}`` so the static ``wheel`` path wins
    route matching. A connected, capable vault's own reading of the user's
    corpus wins; otherwise the balance is computed locally, where fullness
    reuses each stage's ``overall_progress`` signal and a new user sees all
    zeros.
    """
    balance = await select_wheel_balance(vault_client, session, current_user)
    return WheelBalanceResponse(aspects=[WheelAspect(**item) for item in balance])


@router.get("/{stage_number}/progress", response_model=StageProgressResponse)
async def get_stage_progress(
    stage_number: StageNumberPath,
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
    stage_number: StageNumberPath,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> StageHistoryResponse:
    """Aggregated practice and habit history for a stage."""
    if not await stage_exists(session, stage_number):
        raise not_found("stage")

    progress = await get_user_progress(session, current_user)
    if not is_stage_unlocked(stage_number, progress, tz=user_tz):
        raise forbidden("stage_locked")

    practices = await get_stage_practice_history(session, current_user, stage_number)
    habits = await get_stage_habit_history(session, current_user, stage_number)

    return StageHistoryResponse(
        stage_number=stage_number,
        practices=practices,
        habits=habits,
    )


_FIRST_STAGE = 1
_FIRST_CYCLE_COMPLETED: tuple[int, ...] = ()


def _loop_to_next_cycle(existing: StageProgress) -> StageProgressRecord:
    """Mutate a completed-cycle row in place for the next loop, returning its record.

    Resets the calendar anchors (``stage_started_at`` + ``program_started_at``)
    to now so the fresh cycle restarts its schedule instead of instantly
    re-unlocking every stage, bumps ``cycle_number``, and clears
    ``completed_stages`` back to stage 1. No engagement data is touched.
    """
    now = datetime.now(UTC)
    existing.cycle_number += 1
    existing.current_stage = _FIRST_STAGE
    existing.completed_stages = list(_FIRST_CYCLE_COMPLETED)
    existing.stage_started_at = now
    existing.program_started_at = now
    return StageProgressRecord(
        id=existing.id,
        user_id=existing.user_id,
        current_stage=existing.current_stage,
        completed_stages=existing.completed_stages,
        cycle_number=existing.cycle_number,
    )


@router.post("/begin-again", response_model=StageProgressRecord)
async def begin_again(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> StageProgressRecord:
    """Loop the caller's completed program back to stage 1 as a new cycle.

    An explicit, user-driven restart offered only to someone who has reached
    the final stage: ``current_stage`` resets to 1 and ``completed_stages``
    clears while ``cycle_number`` increments, all carried on the single
    existing row. The Stage-10 ``all_stages_completed`` advance signal is left
    intact — this is a separate, opt-in path, not a replacement for it.

    Journal, habit streaks, goal completions, practice sessions, and energy are
    all untouched: the carry-over is automatic and there is no penalty. A user
    mid-cycle (``current_stage < TOTAL_STAGES``) is rejected with
    ``cycle_not_complete``; a user with no progress row at all is rejected and
    no row is created as a side-effect. The row is read under ``FOR UPDATE`` so
    a concurrent advance cannot interleave with the loop reset.
    """
    existing = await get_user_progress_for_update(session, current_user)
    if existing is None:
        raise not_found("stage_progress")
    if existing.current_stage < TOTAL_STAGES:
        raise conflict("cycle_not_complete")

    record = _loop_to_next_cycle(existing)
    session.add(existing)
    await session.commit()
    await session.refresh(existing)
    logger.info(
        "stage_cycle_looped",
        extra={"user_id": existing.user_id, "cycle_number": existing.cycle_number},
    )
    return record
