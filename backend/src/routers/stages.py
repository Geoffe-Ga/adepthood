"""Stage and stage progress API endpoints."""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import Depends, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from bounds import StageNumberPath
from curriculum import CurriculumDataError, phase_chords, stage_curriculum
from database import get_session
from dependencies.creek_vault import get_creek_vault_client
from dependencies.timezone import current_user_timezone
from domain.constants import STAGE_START_WEEKS, TOTAL_STAGES
from domain.creek_vault import CreekVaultClient
from domain.dates import day_bounds_in_tz, ensure_aware, to_user_date, today_in_tz
from domain.pass_rescaffold import (
    arrive_pending_pass,
    loop_to_next_cycle,
    open_pass_on,
    settle_pending_pass,
)
from domain.program_calendar import (
    calendar_stage,
    calendar_week,
    days_until_start,
    effective_anchor,
)
from domain.program_pass import begin_next_pass, live_pass_start, move_live_pass_start
from domain.program_start import (
    ProgramStartBounds,
    pass_start_bounds,
    pass_start_verdict,
    program_start_bounds,
    verdict_within,
)
from domain.stage_authority import reanchor_program, record_stage_entry
from domain.stage_keys import STAGE_KEYS
from domain.stage_progress import (
    compute_stage_progress,
    compute_stage_progress_batch,
    ensure_user_progress,
    get_stage_habit_history,
    get_stage_practice_history,
    get_user_progress,
    get_user_progress_for_update,
    is_stage_unlocked,
    stage_exists,
)
from error_responses import build_router
from errors import conflict, forbidden, not_found, unprocessable
from models.course_stage import CourseStage
from models.stage_progress import StageProgress
from models.user import User
from routers.auth import get_current_user
from schemas import Page, PaginationParams, build_page
from schemas.pagination import paginate_query
from schemas.stage import (
    PassStartRequest,
    ProgramCalendarResponse,
    ProgramStartRequest,
    ProgramStartWindow,
    StageChordNote,
    StageCorrespondenceProvenance,
    StageCorrespondenceResponse,
    StageExpression,
    StageHistoryResponse,
    StageManifestation,
    StageMode,
    StagePhaseChord,
    StageProgressRecord,
    StageProgressResponse,
    StageResponse,
)
from schemas.wheel import WheelAspect, WheelBalanceResponse
from services.creek_vault_wheel import select_wheel_balance

logger = logging.getLogger(__name__)

router = build_router(prefix="/stages", tags=["stages"], extra_statuses=(status.HTTP_409_CONFLICT,))

#: The only cycle whose start date the person may pick (see ``set_program_start``).
_FIRST_CYCLE = 1

#: The week each Stage opens on, by stable key.
_START_WEEK_BY_KEY: dict[str, int] = dict(zip(STAGE_KEYS, STAGE_START_WEEKS, strict=True))


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


def _stage_mode(stage_number: int) -> StageMode | None:
    """Return a stage's Mode statement, or ``None`` when it states none (or the lookup fails)."""
    try:
        mode = stage_curriculum(stage_number).mode
    except CurriculumDataError:
        return None
    if mode is None:
        return None
    return StageMode(
        name=mode.name, description=mode.description, holds_all_modes=mode.holds_all_modes
    )


def _stage_chord(stage_number: int) -> list[StagePhaseChord]:
    """Return a Neither/Both stage's phase chords; empty for every other stage."""
    try:
        chords = phase_chords(stage_number)
    except CurriculumDataError:
        return []
    return [
        StagePhaseChord(
            phase=chord.phase.value,
            notes=[
                StageChordNote(stage_number=note.stage_number, name=note.name)
                for note in chord.notes
            ],
        )
        for chord in chords
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
        mode=_stage_mode(stage.stage_number),
        chord=_stage_chord(stage.stage_number),
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
    a pending pass whose day has come is opened
    (:func:`domain.pass_rescaffold.settle_pending_pass`, issue #3725) and where
    :func:`domain.stage_authority.record_stage_entry` runs: entry into a window
    the calendar has already opened is recorded here, server-side, with nobody
    asking for it. A user with no progress row yet is left alone — these are
    read endpoints, and provisioning a row is the job of the depths a person can
    take alone (the course reading, and the habits list when a laddered habit
    awaits its ring), not the Map's.
    """
    progress = await get_user_progress(session, user_id)
    if progress is None:
        return None
    settled = await settle_pending_pass(session, progress, tz=tz)
    return await record_stage_entry(session, settled, tz=tz)


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


def _correspondence_response(stage: CourseStage, stage_key: str) -> StageCorrespondenceResponse:
    """Project one keyed ``CourseStage`` row onto the correspondence contract."""
    return StageCorrespondenceResponse(
        stage_key=stage_key,
        stage_number=stage.stage_number,
        start_week=_START_WEEK_BY_KEY[stage_key],
        category=stage.category,
        aspect=stage.aspect,
        spiral_dynamics_color=stage.spiral_dynamics_color,
        growing_up_stage=stage.growing_up_stage,
        divine_gender_polarity=stage.divine_gender_polarity,
        relationship_to_free_will=stage.relationship_to_free_will,
        free_will_description=stage.free_will_description,
        provenance=StageCorrespondenceProvenance(
            source_repo=stage.source_repo,
            source_sha=stage.source_sha,
            source_path=stage.source_path,
            source_sha256=stage.source_sha256,
            schema_version=stage.artifact_schema_version,
            reconciled_at=stage.reconciled_at,
        ),
    )


@router.get("/correspondence", response_model=list[StageCorrespondenceResponse])
async def list_stage_correspondence(
    _current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> list[StageCorrespondenceResponse]:
    """The canonical per-Stage correspondences, keyed by stable stage key (#2665).

    Global reference data: identical for every user, so there is no progress
    overlay and reading it is not a visit. The set is fixed at the ten
    Stages, so the list is not paginated; a legacy row outside them (an
    orphan the seeder kept rather than deleted) is not served. Ordered by
    ``stage_number`` then ``id`` for a total order. Registered ABOVE
    ``/{stage_number}`` so the static path wins route matching.
    """
    query = (
        select(CourseStage)
        .where(col(CourseStage.stage_key).in_(STAGE_KEYS))
        .order_by(col(CourseStage.stage_number).asc(), col(CourseStage.id).asc())
    )
    stages = (await session.execute(query)).scalars().all()
    return [_correspondence_response(stage, str(stage.stage_key)) for stage in stages]


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
    bounds = await _program_start_bounds(session, current_user, user_tz)
    if progress is None:
        return ProgramCalendarResponse(
            program_started_at=None,
            calendar_stage=1,
            calendar_week=1,
            current_stage=1,
            cycle_number=1,
            program_start_window=_window(bounds),
            pass_start_window=_window(bounds),
        )
    floor = await live_pass_start(session, progress, tz=user_tz)
    return _calendar_response(progress, user_tz, bounds, floor)


def _window(bounds: ProgramStartBounds) -> ProgramStartWindow:
    """Project the domain range onto its wire shape."""
    return ProgramStartWindow(earliest=bounds.earliest, latest=bounds.latest)


def _calendar_response(
    progress: StageProgress, tz: str, bounds: ProgramStartBounds, pass_floor: date
) -> ProgramCalendarResponse:
    """Project a progress row onto the calendar contract, counted in ``tz``.

    The pickable window is offered only in the first cycle; after begin-again
    the anchor is fixed, so there is no range to offer and the window is null.
    The window a new pass may open in (issue #3725) is offered in every cycle,
    floored at ``pass_floor``, the running pass's own start.
    """
    today = today_in_tz(tz)
    anchor = effective_anchor(progress, today, tz=tz)
    return ProgramCalendarResponse(
        program_started_at=anchor,
        calendar_stage=calendar_stage(anchor, tz=tz),
        calendar_week=calendar_week(anchor, tz=tz),
        current_stage=progress.current_stage,
        cycle_number=progress.cycle_number,
        program_start_window=_window(bounds) if progress.cycle_number <= _FIRST_CYCLE else None,
        days_until_start=days_until_start(progress, today, tz=tz),
        pending_pass_starts_on=progress.pending_pass_starts_on,
        pass_start_window=_window(pass_start_bounds(bounds, current_pass_start=pass_floor)),
    )


async def _program_start_bounds(session: AsyncSession, user_id: int, tz: str) -> ProgramStartBounds:
    """The range ``user_id`` may pick from today, both ends counted in ``tz``."""
    user = await session.get(User, user_id)
    if user is None:
        raise not_found("user")
    return program_start_bounds(
        today=today_in_tz(tz),
        account_created=to_user_date(tz, ensure_aware(user.created_at)),
    )


#: Refusal reasons for a picked start date, by :func:`program_start_verdict` verdict.
_PROGRAM_START_REFUSALS: dict[str, str] = {
    "future": "program_start_in_future",
    "too_early": "program_start_too_early",
    "before_current_start": "pass_start_before_current_pass",
}


async def _validate_program_start(
    session: AsyncSession, user_id: int, chosen: date, tz: str
) -> ProgramStartBounds:
    """Refuse a date outside the pickable range with 422, before anything is written."""
    bounds = await _program_start_bounds(session, user_id, tz)
    _refuse_outside(verdict_within(chosen, bounds))
    return bounds


@router.put("/program-calendar", response_model=ProgramCalendarResponse)
async def set_program_start(
    payload: ProgramStartRequest,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> ProgramCalendarResponse:
    """Let the person pick, or change, the date their program starts on (#3097).

    The anchor is stored as local midnight of ``program_start_date`` in the
    caller's zone, so the calendar counts exactly the days the person sees.
    A person with no progress row yet -- a habits-only account the first time
    it needs an anchor -- gets one provisioned here, so the choice can be made
    before the server would otherwise stamp ``now``.

    The record moves with the anchor in the same write
    (:func:`domain.stage_authority.reanchor_program`), so every reader --
    habit reveal, course drip, prompts -- agrees from the next request on.
    Invitations already consumed stay consumed: a habit ring revealed under the
    old date is neither re-locked nor re-stamped.

    The live pass (issue #3723) starts on the chosen day too, in the same
    commit, so the record of this first pass measures from the date the person
    actually began. It is a correction of the pass the person is in, not a new
    pass (that is ``POST /stages/passes``, issue #3725), so a day still ahead
    leaves the program "not yet begun" until it comes, and any pass pending
    behind this one is dropped -- the latest save wins.

    Refused with 422 outside the range :mod:`domain.program_start` defines, and
    with 409 ``program_start_fixed_after_first_cycle`` once begin-again has run,
    because a later cycle's anchor is also its predecessor's recorded end.
    """
    chosen = payload.program_start_date
    bounds = await _validate_program_start(session, current_user, chosen, user_tz)
    progress = await ensure_user_progress(session, current_user)
    await session.refresh(progress, with_for_update=True)
    await arrive_pending_pass(session, progress, now=datetime.now(UTC), tz=user_tz)
    if progress.cycle_number > _FIRST_CYCLE:
        raise conflict("program_start_fixed_after_first_cycle")
    await _reanchor_first_pass(session, progress, chosen, user_tz)
    await session.commit()
    await session.refresh(progress)
    logger.info(
        "program_start_picked",
        extra={"user_id": current_user, "current_stage": progress.current_stage},
    )
    floor = await live_pass_start(session, progress, tz=user_tz)
    return _calendar_response(progress, user_tz, bounds, floor)


async def _reanchor_first_pass(
    session: AsyncSession, progress: StageProgress, chosen: date, tz: str
) -> None:
    """Move the first cycle's anchor, record and live pass to ``chosen``; no commit.

    A correction of the pass the person is in, not a new one, so it also drops
    any pass pending behind it: the latest save wins, as a second pending save
    replaces the first.
    """
    anchor, _ = day_bounds_in_tz(tz, chosen)
    reanchor_program(progress, anchor, tz=tz)
    await move_live_pass_start(session, progress.user_id, chosen)
    progress.pending_pass_starts_on = None
    session.add(progress)


@router.post("/passes", response_model=ProgramCalendarResponse, status_code=status.HTTP_201_CREATED)
async def open_program_pass(
    payload: PassStartRequest,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> ProgramCalendarResponse:
    """Open a new pass through the stages on ``start_day`` -- an Energy Scaffolding save (#3725).

    Allowed in any cycle. Under the same ``FOR UPDATE`` lock the program-start
    PUT takes, the running pass is closed the day before ``start_day`` and the
    next opens there with ``origin = rescaffold``; the cycle loops as
    begin-again's does, so the closed cycle's recorded end stays true.

    A ``start_day`` still ahead is held as the pending pass
    (``pending_pass_starts_on``): the running pass keeps running, and keeps
    driving stage, habit reveal and Course pacing, until the day before it, and
    is closed with what it actually reached on the first read on or after the
    day. A second save while one is pending replaces it.

    Someone with no progress row has no pass to close, so their save starts
    pass 1 on the day, exactly as the first-cycle PUT would.

    Refused with 422 ``program_start_in_future`` past one program ahead,
    ``program_start_too_early`` before the back-date floor, and
    ``pass_start_before_current_pass`` before the running pass's own start.
    """
    chosen = payload.start_day
    bounds = await _program_start_bounds(session, current_user, user_tz)
    if await get_user_progress(session, current_user) is None:
        _refuse_outside(verdict_within(chosen, bounds))
        progress = await ensure_user_progress(session, current_user)
        await session.refresh(progress, with_for_update=True)
        await _reanchor_first_pass(session, progress, chosen, user_tz)
    else:
        progress = await _open_pass_locked(session, current_user, chosen, bounds, user_tz)
    await session.commit()
    await session.refresh(progress)
    logger.info(
        "program_pass_opened",
        extra={"user_id": current_user, "cycle_number": progress.cycle_number},
    )
    floor = await live_pass_start(session, progress, tz=user_tz)
    return _calendar_response(progress, user_tz, bounds, floor)


def _refuse_outside(verdict: str) -> None:
    """Raise the 422 a non-``ok`` start-day verdict maps to."""
    if verdict != "ok":
        raise unprocessable(_PROGRAM_START_REFUSALS[verdict])


async def _open_pass_locked(
    session: AsyncSession, user_id: int, chosen: date, bounds: ProgramStartBounds, tz: str
) -> StageProgress:
    """Lock the row, then open (or hold as pending) a pass on ``chosen``; no commit.

    A pending pass whose day has already come is opened first, so the floor is
    measured against the pass actually running today.
    """
    progress = await get_user_progress_for_update(session, user_id)
    if progress is None:
        raise not_found("stage_progress")
    now = datetime.now(UTC)
    await arrive_pending_pass(session, progress, now=now, tz=tz)
    floor = await live_pass_start(session, progress, tz=tz)
    _refuse_outside(pass_start_verdict(chosen, bounds, current_pass_start=floor))
    if chosen > to_user_date(tz, now):
        progress.pending_pass_starts_on = chosen
    else:
        await open_pass_on(session, progress, chosen, now=now, tz=tz)
    session.add(progress)
    return progress


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


def _loop_to_next_cycle(existing: StageProgress, now: datetime) -> StageProgressRecord:
    """Loop a completed-cycle row into the next cycle at ``now``, returning its record.

    The loop itself is :func:`domain.pass_rescaffold.loop_to_next_cycle`, shared
    with the scaffolding re-run. ``now`` is passed in rather than read here so
    the pass record written alongside (issue #3723) dates the incoming pass from
    the very instant that becomes its anchor.
    """
    loop_to_next_cycle(existing, now)
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
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> StageProgressRecord:
    """Loop the caller's completed program back to stage 1 as a new cycle.

    An explicit, user-driven restart offered only to someone who has reached
    the final stage: ``current_stage`` resets to 1 and ``completed_stages``
    clears while ``cycle_number`` increments, all carried on the single
    existing row. The Stage-10 ``all_stages_completed`` advance signal is left
    intact — this is a separate, opt-in path, not a replacement for it.

    The outgoing cycle's ``program_started_at`` is retained on
    ``past_cycle_anchors`` in the same commit (issue #2894), so a review written
    during that cycle can still be windowed against the calendar it was written
    about instead of losing its period forever.

    The pass record moves in that commit too (issue #3723): the live pass is
    closed the day before today in the caller's zone, with the stage and week it
    reached measured from its own start, and the next pass opens today. A pass
    pending from a scaffolding save (issue #3725) is dropped by the loop; one
    whose day has already come is opened first, which puts the person back at
    stage 1 and so refuses the loop.

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
    now = datetime.now(UTC)
    await arrive_pending_pass(session, existing, now=now, tz=user_tz)
    if existing.current_stage < TOTAL_STAGES:
        raise conflict("cycle_not_complete")

    await begin_next_pass(session, existing, now=now, tz=user_tz)
    record = _loop_to_next_cycle(existing, now)
    session.add(existing)
    await session.commit()
    await session.refresh(existing)
    logger.info(
        "stage_cycle_looped",
        extra={"user_id": existing.user_id, "cycle_number": existing.cycle_number},
    )
    return record
