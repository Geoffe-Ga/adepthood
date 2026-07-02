"""User-practices API — select a practice per stage and view selections."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date
from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from dependencies.ownership import require_owned_user_practice
from dependencies.timezone import current_user_timezone
from domain.dates import today_in_tz
from domain.practice_resolution import effective_config, effective_name
from domain.stage_progress import get_user_progress, is_stage_unlocked
from errors import bad_request, conflict, forbidden, not_found
from models.course_stage import CourseStage
from models.practice import Practice
from models.practice_session import PracticeSession
from models.user_practice import UserPractice
from routers.auth import get_current_user
from schemas import MAX_PAGE_SIZE, Page, PaginationParams, build_page
from schemas.frequency import FrequencyResponse, render_banner_text
from schemas.pagination import page_has_more, paginate_query
from schemas.practice import (
    PracticeSessionSummary,
    UserPracticeCreate,
    UserPracticeCustomize,
    UserPracticeDetail,
    UserPracticeResponse,
)
from schemas.practice_mode_config import ModeConfigAdapter
from seed_practices import STAGE_TO_PRESET_NAME
from seed_stages import STAGE_DEFINITIONS

# Stage 1 is always the curriculum's entry point — users without a
# ``StageProgress`` row see the stage-1 banner because they have not yet
# advanced. Mirrors ``domain.stage_progress._STAGE_1`` (kept duplicated
# rather than imported so this router doesn't reach into a private
# constant in another module).
_DEFAULT_STAGE_NUMBER = 1

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/user-practices", tags=["user-practices"])


async def _resolve_practice(session: AsyncSession, practice_id: int) -> Practice:
    """Fetch and validate the catalog practice (exists + approved)."""
    result = await session.execute(select(Practice).where(Practice.id == practice_id))
    practice = result.scalars().first()
    if practice is None:
        raise not_found("practice")
    if not practice.approved:
        raise bad_request("practice_not_approved")
    return practice


async def _resolve_selectable_practice(
    session: AsyncSession, practice_id: int, current_user: int
) -> Practice:
    """Fetch a practice the caller is allowed to *select* for a stage.

    Unlike :func:`_resolve_practice` (the read/customize path), this write
    path permits an approved catalog practice **or** the caller's own draft:
    ``practice.submitted_by_user_id == current_user`` clears an unapproved
    row so an author can activate the practice they just submitted. A
    non-owner selecting someone else's still-pending submission continues to
    receive 400 ``practice_not_approved``; a missing row 404s exactly as the
    read path does.
    """
    result = await session.execute(select(Practice).where(Practice.id == practice_id))
    practice = result.scalars().first()
    if practice is None:
        raise not_found("practice")
    if not (practice.approved or practice.submitted_by_user_id == current_user):
        raise bad_request("practice_not_approved")
    return practice


async def _check_stage_eligibility(
    session: AsyncSession,
    current_user: int,
    practice: Practice,
    payload_stage_number: int,
) -> None:
    """Gate on catalog-stage agreement + chain-unlock.

    Kept separate from :func:`_resolve_practice` so the 400/403 split stays
    explicit: mismatched stage is a client-side input error, locked stage is
    an authorization failure against server-owned progression.
    """
    if practice.stage_number != payload_stage_number:
        raise bad_request("stage_number_mismatch")
    progress = await get_user_progress(session, current_user)
    if not is_stage_unlocked(payload_stage_number, progress):
        raise forbidden("stage_locked")


async def _free_stage_slot(
    session: AsyncSession,
    current_user: int,
    payload: UserPracticeCreate,
    today: date,
) -> UserPractice | None:
    """Ready the stage's single open slot for a new selection.

    Returns the existing open row **only** when it already points at the
    requested practice -- the caller short-circuits on that to keep
    re-selecting the current pick an idempotent no-op (no new row, no
    ``start_date`` reset). In every other case it returns ``None`` after
    closing any open row, so the caller can safely insert the new one.

    The close is flushed before returning so the ``UPDATE`` lands ahead
    of the caller's ``INSERT``; otherwise the unit of work could order
    the insert first, momentarily leave two open rows for the stage, and
    trip ``ix_user_practice_active_stage`` on a replacement that should
    have succeeded.
    """
    existing = await _load_active_user_practice(session, current_user, payload.stage_number)
    if existing is None:
        return None
    if existing.practice_id == payload.practice_id:
        return existing
    existing.end_date = today
    session.add(existing)
    await session.flush()
    return None


@router.post("/", response_model=UserPracticeResponse, status_code=status.HTTP_201_CREATED)
async def create_user_practice(
    payload: UserPracticeCreate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> UserPractice:
    """Select (or replace) the active practice for a stage.

    This is the "Replace this practice" / "Use for stage" write. The
    ``ix_user_practice_active_stage`` partial unique index enforces "at
    most one open ``UserPractice`` per ``(user, stage)``" at the DB
    level (BUG-PRACTICE-005) -- which means a bare insert *fails* when
    the user already has an active pick for the stage. That is the
    common case (switching away from the seeded default), so we close
    the prior open row before inserting the new one rather than 409ing
    the user out of ever switching (BUG-PRACTICE-012).

    Concurrency is still safe: the close + insert happen in one
    transaction, and the partial unique index remains the single source
    of truth. If two replacements race, the index lets exactly one new
    open row land and the loser rolls back to 409
    ``active_practice_exists_for_stage`` -- now a transient "try again",
    not a permanent wall.

    Re-selecting the practice that is *already* active is a no-op: the
    existing row is returned untouched so an accidental double-tap can't
    reset ``start_date`` (the user-facing "I started this" label) or the
    streak math that hangs off it.
    """
    practice = await _resolve_selectable_practice(session, payload.practice_id, current_user)
    await _check_stage_eligibility(session, current_user, practice, payload.stage_number)

    # ``start_date`` is the user-facing "I started this practice today"
    # label (BUG-HABIT-006), not an internal audit timestamp -- so it
    # uses the user's calendar, not server UTC.  A user in Pacific
    # signing up at 11:00 PM Pacific used to see "started tomorrow"
    # because UTC had already rolled over.
    today = today_in_tz(user_tz)

    already_active = await _free_stage_slot(session, current_user, payload, today)
    if already_active is not None:
        return already_active

    user_practice = UserPractice(
        user_id=current_user,
        practice_id=payload.practice_id,
        stage_number=payload.stage_number,
        start_date=today,
    )
    session.add(user_practice)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        # Lost a concurrent replacement race: another request already
        # closed the prior row and opened its own. Surface 409 so the
        # client retries against fresh state instead of double-inserting.
        raise conflict("active_practice_exists_for_stage") from exc
    await session.refresh(user_practice)
    logger.info(
        "user_practice_created",
        extra={
            "user_id": current_user,
            "practice_id": payload.practice_id,
            "stage_number": payload.stage_number,
        },
    )
    return user_practice


def _safe_resolve_config(item: UserPractice, practice: Practice) -> dict[str, Any] | None:
    """Resolve ``effective_config`` defensively for read paths.

    Pre-flight validation at the PATCH edge prevents corrupt overrides
    from being written through the normal API, but a row can arrive via
    direct DB tooling, an admin script, or a catalog mode being edited
    after users stored overrides for it. Returning ``None`` with a
    warning lets the rest of the user's list still render instead of
    blowing up the whole page with a 500.
    """
    try:
        return effective_config(practice, item).model_dump()
    except (ValueError, ValidationError):
        logger.warning(
            "corrupt_mode_config_override",
            extra={
                "user_practice_id": item.id,
                "practice_id": practice.id,
                "mode": practice.mode,
            },
        )
        return None


def _list_row_payload(item: UserPractice, practice: Practice | None) -> dict[str, Any]:
    """Build the response dict for one row in the list endpoint.

    Falls back to ``effective_*: None`` when the catalog row is missing
    (a user-practice can outlive its catalog parent during soft-deletes
    where the FK isn't enforced) or when the stored override is
    corrupt — see :func:`_safe_resolve_config`.
    """
    payload: dict[str, Any] = {
        **_user_practice_payload(item),
        "effective_name": None,
        "effective_config": None,
    }
    if practice is not None:
        payload["effective_name"] = effective_name(practice, item)
        payload["effective_config"] = _safe_resolve_config(item, practice)
    return payload


async def _load_catalog_map(session: AsyncSession, practice_ids: set[int]) -> dict[int, Practice]:
    """One batched ``SELECT … WHERE id IN (…)`` over the catalog.

    Avoids the N+1 the per-row resolver would incur in the list path.
    """
    if not practice_ids:
        return {}
    rows = (
        (await session.execute(select(Practice).where(col(Practice.id).in_(practice_ids))))
        .scalars()
        .all()
    )
    return {p.id: p for p in rows if p.id is not None}


async def _build_list_response(
    session: AsyncSession, items: list[UserPractice]
) -> list[UserPracticeResponse]:
    """Resolve ``effective_name`` / ``effective_config`` for each item.

    Catalog rows are batched via :func:`_load_catalog_map`; corrupt
    overrides fall through to ``effective_config: None`` via
    :func:`_safe_resolve_config` so a single bad row never crashes
    the whole page.
    """
    catalog = await _load_catalog_map(session, {item.practice_id for item in items})
    return [
        UserPracticeResponse.model_validate(_list_row_payload(item, catalog.get(item.practice_id)))
        for item in items
    ]


@router.get("/", response_model=None)
async def list_user_practices(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    pagination: Annotated[PaginationParams, Depends()],
) -> Page[UserPracticeResponse] | list[UserPracticeResponse]:
    """List the authenticated user's practice selections.

    BUG-INFRA-017: returns ``Page[UserPracticeResponse]`` when
    ``?paginate=true`` is set; otherwise the legacy bare list is returned
    for one release while the frontend migrates to the envelope.
    """
    query = select(UserPractice).where(UserPractice.user_id == current_user)
    items, total = await paginate_query(session, query, pagination)
    serialized = await _build_list_response(session, list(items))
    if pagination.paginate:
        return build_page(serialized, total, pagination)
    return serialized


async def _resolve_effective_fields(
    session: AsyncSession, user_practice: UserPractice
) -> tuple[str, dict[str, Any] | None]:
    """Look up the catalog Practice and return (effective_name, effective_config_dict).

    Used by the GET-one endpoint. PATCH holds its own ``practice``
    reference from pre-flight validation and calls the resolvers
    directly to avoid a redundant DB round-trip; the list endpoint
    batches catalog lookups via :func:`_load_catalog_map`. The config
    is resolved via :func:`_safe_resolve_config` so a corrupt stored
    override falls through to ``None`` rather than crashing the GET.
    """
    practice = await _resolve_practice(session, user_practice.practice_id)
    name = effective_name(practice, user_practice)
    return name, _safe_resolve_config(user_practice, practice)


def _user_practice_payload(user_practice: UserPractice) -> dict[str, Any]:
    """Serialize the user-practice row's stored columns (no resolution yet)."""
    return {
        "id": user_practice.id,
        "practice_id": user_practice.practice_id,
        "stage_number": user_practice.stage_number,
        "start_date": user_practice.start_date,
        "end_date": user_practice.end_date,
        "custom_name": user_practice.custom_name,
        "mode_config_override": user_practice.mode_config_override,
    }


def build_user_practice_detail(
    user_practice: UserPractice,
    *,
    effective_name: str | None,
    effective_config: dict[str, Any] | None,
    sessions_page: tuple[list[PracticeSession], int, bool],
) -> UserPracticeDetail:
    """Build the typed ``UserPracticeDetail`` from stored + resolved fields.

    The single source of the response's key list — GET-one, customize, and
    apply-recipe all build the model through here, so a field rename on
    ``UserPracticeDetail`` flows to every endpoint without per-site edits.
    ``sessions_page`` is the ``load_recent_sessions`` tuple ``(rows, total,
    has_more)``; ``effective_config`` dicts and ``PracticeSession`` rows are
    coerced by the model's validators / ``from_attributes``.
    """
    sessions, sessions_total, sessions_has_more = sessions_page
    # Direct construction doesn't apply ``from_attributes`` to the nested ORM
    # rows, so coerce them to the summary schema first; the rest are plain
    # values / dicts the model validates inline.
    summaries = [PracticeSessionSummary.model_validate(s, from_attributes=True) for s in sessions]
    return UserPracticeDetail(
        **_user_practice_payload(user_practice),
        effective_name=effective_name,
        effective_config=effective_config,
        sessions=summaries,
        sessions_total=sessions_total,
        sessions_has_more=sessions_has_more,
    )


async def _load_course_stage(session: AsyncSession, stage_number: int) -> CourseStage:
    """Fetch the ``CourseStage`` for a stage number or raise 404.

    The banner copy interpolates ``spiral_dynamics_color`` and ``aspect``
    from this row; a half-seeded environment (e.g. preset practices
    landed but stage definitions didn't) is a deployment bug, not a
    user-recoverable state — surfacing it as 404 with a stable detail
    string makes the misconfiguration debuggable in logs.
    """
    result = await session.execute(
        select(CourseStage).where(CourseStage.stage_number == stage_number)
    )
    course_stage = result.scalars().first()
    if course_stage is None:
        raise not_found("course_stage")
    return course_stage


async def _load_active_user_practice(
    session: AsyncSession, user_id: int, stage_number: int
) -> UserPractice | None:
    """Return the user's open ``UserPractice`` for a stage, or ``None``.

    "Open" mirrors the production partial unique index
    (``ix_user_practice_active_stage``): ``end_date IS NULL``. The
    constraint guarantees ≤ 1 row matches so ``.first()`` is safe; a
    legacy DB without the index would still resolve deterministically
    because we order by ``id DESC`` and pick the most recent open row.
    """
    result = await session.execute(
        select(UserPractice)
        .where(
            UserPractice.user_id == user_id,
            UserPractice.stage_number == stage_number,
            col(UserPractice.end_date).is_(None),
        )
        .order_by(col(UserPractice.id).desc())
    )
    return result.scalars().first()


async def _load_preset_practice(session: AsyncSession, stage_number: int) -> Practice:
    """Look up the seeded preset for a stage by ``(stage_number, name)``.

    The lookup key comes from :data:`STAGE_TO_PRESET_NAME` (exported
    from :mod:`seed_practices`) so the banner stays in sync with the
    seeder by construction — a typo in either place is caught at the
    seeder's import-time validation, not on the first banner fetch.

    Raises 404 when the preset row is missing (same half-seeded
    deployment posture as :func:`_load_course_stage`).
    """
    preset_name = STAGE_TO_PRESET_NAME.get(stage_number)
    if preset_name is None:
        raise not_found("preset_practice")
    result = await session.execute(
        select(Practice).where(
            Practice.stage_number == stage_number,
            Practice.name == preset_name,
            col(Practice.submitted_by_user_id).is_(None),
        )
    )
    practice = result.scalars().first()
    if practice is None:
        raise not_found("preset_practice")
    return practice


def _build_frequency_response(
    *,
    course_stage: CourseStage,
    practice_name: str,
    practice_id: int,
    user_practice_id: int | None,
) -> FrequencyResponse:
    """Compose the response payload with the banner text rendered once.

    Kept as a thin helper so the endpoint's two branches (active
    selection vs preset fallback) share one call site for the render —
    a wording or field-list drift between the two branches becomes
    impossible by construction.
    """
    return FrequencyResponse(
        stage_number=course_stage.stage_number,
        color=course_stage.spiral_dynamics_color,
        aspect=course_stage.aspect,
        practice_name=practice_name,
        practice_id=practice_id,
        user_practice_id=user_practice_id,
        banner_text=render_banner_text(
            color=course_stage.spiral_dynamics_color,
            aspect=course_stage.aspect,
            practice_name=practice_name,
        ),
    )


async def _frequency_from_active(
    session: AsyncSession, course_stage: CourseStage, active: UserPractice
) -> FrequencyResponse:
    """Build the banner from an active ``UserPractice`` selection.

    ``_resolve_practice`` 400s on unapproved rows; for the banner path
    we only need the catalog row to exist (the user already selected
    it, so its approval state shouldn't break their read view).
    """
    practice_row = (
        (await session.execute(select(Practice).where(Practice.id == active.practice_id)))
        .scalars()
        .first()
    )
    if practice_row is None:
        raise not_found("practice")
    # ``Practice.id`` is typed ``int | None`` to model the pre-insert
    # state; a row returned from a ``SELECT`` always has its primary
    # key set, so the cast narrows the type for mypy without a silent
    # ``or 0`` fallback that would mask a real bug. Same pattern as
    # :func:`domain.stage_progress.get_stage_habit_history`.
    return _build_frequency_response(
        course_stage=course_stage,
        practice_name=effective_name(practice_row, active),
        practice_id=cast("int", practice_row.id),
        user_practice_id=active.id,
    )


async def _frequency_from_preset(
    session: AsyncSession, course_stage: CourseStage, stage_number: int
) -> FrequencyResponse:
    """Build the banner from the seeded preset for a stage.

    Surfaces ``user_practice_id = None`` so the client can distinguish
    "showing the unselected default" from "showing the user's pick".
    """
    preset = await _load_preset_practice(session, stage_number)
    # See :func:`_frequency_from_active` for the rationale on the
    # post-SELECT id cast.
    return _build_frequency_response(
        course_stage=course_stage,
        practice_name=preset.name,
        practice_id=cast("int", preset.id),
        user_practice_id=None,
    )


@router.get("/current/frequency", response_model=FrequencyResponse)
async def get_current_frequency(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    stage_number: Annotated[
        int | None,
        Query(
            ge=1,
            le=len(STAGE_DEFINITIONS),
            description=(
                "Pin the banner to a specific stage. When omitted the server "
                "derives the stage from the user's StageProgress. Clients pass "
                "their own resolved stage here so the banner stays in lockstep "
                "with whatever practice the user is actually looking at."
            ),
        ),
    ] = None,
) -> FrequencyResponse:
    """Return the banner payload for a stage (ritual-05).

    Collapses four lookups (``StageProgress`` → ``CourseStage`` →
    ``UserPractice`` → ``Practice``) into one response so the client
    never has to assemble the banner copy from parts. The template
    lives server-side in :mod:`schemas.frequency` so a wording change
    is a single-file edit.

    Stage resolution:

    * ``stage_number`` query param (when provided) wins. Clients that
      resolve the active stage on their own pass it here so the banner
      tracks the practice they're showing, instead of whatever
      ``StageProgress.current_stage`` happens to hold.
    * Otherwise fall back to ``StageProgress.current_stage`` (or stage
      1 for a fresh user with no progress row).

    Resolution order for the practice slot:

    1. The user's active ``UserPractice`` for the resolved stage (open
       row, ``end_date IS NULL``). ``effective_name`` from
       :mod:`domain.practice_resolution` honours ``custom_name``.
    2. The seeded preset for the stage (via
       :data:`seed_practices.STAGE_TO_PRESET_NAME`) — ``user_practice_id``
       is ``None`` to signal "showing the unselected default" to the
       client.
    """
    if stage_number is None:
        progress = await get_user_progress(session, current_user)
        stage_number = progress.current_stage if progress is not None else _DEFAULT_STAGE_NUMBER

    course_stage = await _load_course_stage(session, stage_number)
    active = await _load_active_user_practice(session, current_user, stage_number)
    if active is not None:
        return await _frequency_from_active(session, course_stage, active)
    return await _frequency_from_preset(session, course_stage, stage_number)


# Cap on inline practice-session history embedded in a single user-practice
# response. Older sessions stay reachable via the paginated list_sessions
# endpoint (issue #474); the cap is applied in SQL (LIMIT), never by slicing a
# full fetch, so a long history never materialises in one response.
EMBEDDED_SESSIONS_DEFAULT_LIMIT = 50


@dataclass
class EmbeddedSessionsParams:
    """Query params bounding the embedded ``sessions[]`` (issue #474).

    Defaults keep the embed at the cap; clients can page within it (or fetch
    older sessions through the standalone ``list_sessions`` endpoint).
    """

    sessions_limit: int = Query(default=EMBEDDED_SESSIONS_DEFAULT_LIMIT, ge=1, le=MAX_PAGE_SIZE)
    sessions_offset: int = Query(default=0, ge=0)


async def load_recent_sessions(
    session: AsyncSession,
    user_practice_id: int,
    params: EmbeddedSessionsParams,
) -> tuple[list[PracticeSession], int, bool]:
    """Newest-first slice of a practice's sessions, capped in SQL (issue #474).

    Returns ``(sessions, total, has_more)``. The ``LIMIT`` is applied in the
    query, so a long history never materialises in one response; ``has_more``
    tells the client older sessions exist behind ``list_sessions``.
    """
    query = (
        select(PracticeSession)
        .where(PracticeSession.user_practice_id == user_practice_id)
        .order_by(col(PracticeSession.timestamp).desc())
    )
    page_params = PaginationParams(
        limit=params.sessions_limit, offset=params.sessions_offset, paginate=True
    )
    sessions, total = await paginate_query(session, query, page_params)
    has_more = page_has_more(params.sessions_offset, params.sessions_limit, total)
    return sessions, total, has_more


@router.get("/{user_practice_id}", response_model=UserPracticeDetail)
async def get_user_practice(
    session: Annotated[AsyncSession, Depends(get_session)],
    user_practice: Annotated[UserPractice, Depends(require_owned_user_practice)],
    embed: Annotated[EmbeddedSessionsParams, Depends()],
) -> UserPracticeDetail:
    """Get a single user-practice with its (capped) recent session history.

    Ownership via ``require_owned_user_practice`` (404 → 403 split). The
    embedded ``sessions[]`` is bounded to ``EMBEDDED_SESSIONS_DEFAULT_LIMIT``
    newest-first sessions; ``sessions_total`` / ``sessions_has_more`` report
    whether older sessions remain (fetch them via ``list_sessions``). Issue #474.
    """
    sessions_page = await load_recent_sessions(session, cast("int", user_practice.id), embed)
    name, cfg = await _resolve_effective_fields(session, user_practice)

    return build_user_practice_detail(
        user_practice,
        effective_name=name,
        effective_config=cfg,
        sessions_page=sessions_page,
    )


def _validate_mode_config_against_catalog(
    config: dict[str, Any] | None, practice: Practice
) -> None:
    """Pre-flight validation for a mode-config that will land in a UserPractice.

    The single gate shared by the customise route (per-user override) and the
    recipe-apply route (materialised recipe): both write to
    ``UserPractice.mode_config_override`` and both must (a) parse cleanly under
    ``ModeConfigAdapter`` and (b) match the catalog ``mode``.  Runs *before*
    persisting so a bad config never reaches the post-write resolver (which
    would 500).  A ``ValidationError`` becomes a 422 carrying Pydantic's
    structured per-field errors (``unprocessable()`` only takes a string
    detail); a mode mismatch becomes a domain-meaningful 400.  ``None``
    (the customise "clear the override" case) short-circuits.
    """
    if config is None:
        return
    try:
        cfg = ModeConfigAdapter.validate_python(config)
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=exc.errors(),
        ) from exc
    if cfg.mode != practice.mode:
        raise bad_request("mode_mismatch")


@router.patch("/{user_practice_id}/customize", response_model=UserPracticeDetail)
async def customize_user_practice(
    payload: UserPracticeCustomize,
    session: Annotated[AsyncSession, Depends(get_session)],
    user_practice: Annotated[UserPractice, Depends(require_owned_user_practice)],
    embed: Annotated[EmbeddedSessionsParams, Depends()],
) -> UserPracticeDetail:
    """Per-user override of name + mode_config.

    Both fields are nullable; passing ``None`` clears the override and
    falls back to the catalog value. Mode-shifting is rejected with
    400 ``mode_mismatch`` because mode changes are conceptually a
    practice replacement, not a tweak.
    """
    practice = await _resolve_practice(session, user_practice.practice_id)
    fields_set = payload.model_fields_set

    if "mode_config_override" in fields_set:
        _validate_mode_config_against_catalog(payload.mode_config_override, practice)
        user_practice.mode_config_override = payload.mode_config_override
    if "custom_name" in fields_set:
        user_practice.custom_name = payload.custom_name

    session.add(user_practice)
    await session.commit()
    await session.refresh(user_practice)

    name = effective_name(practice, user_practice)
    cfg = effective_config(practice, user_practice).model_dump()

    sessions_page = await load_recent_sessions(session, cast("int", user_practice.id), embed)
    logger.info(
        "user_practice_customized",
        extra={
            "user_practice_id": user_practice.id,
            "user_id": user_practice.user_id,
            "fields_changed": sorted(fields_set),
        },
    )
    return build_user_practice_detail(
        user_practice,
        effective_name=name,
        effective_config=cfg,
        sessions_page=sessions_page,
    )
