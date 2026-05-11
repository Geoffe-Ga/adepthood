"""User-practices API — select a practice per stage and view selections."""

from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from dependencies.ownership import require_owned_user_practice
from domain.dates import today_in_tz
from domain.practice_resolution import effective_config, effective_name
from domain.stage_progress import get_user_progress, is_stage_unlocked
from errors import bad_request, conflict, forbidden, not_found
from models.practice import Practice
from models.practice_session import PracticeSession
from models.user_practice import UserPractice
from routers.auth import get_current_user
from schemas import Page, PaginationParams, build_page
from schemas.pagination import paginate_query
from schemas.practice import (
    UserPracticeCreate,
    UserPracticeCustomize,
    UserPracticeDetail,
    UserPracticeResponse,
)
from schemas.practice_mode_config import ModeConfigAdapter
from services.users import get_user_timezone

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


@router.post("/", response_model=UserPracticeResponse, status_code=status.HTTP_201_CREATED)
async def create_user_practice(
    payload: UserPracticeCreate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> UserPractice:
    """Select a practice for a stage, creating a UserPractice record.

    The ``ix_user_practice_active_stage`` partial unique index enforces
    "at most one open ``UserPractice`` per ``(user, stage)``" at the
    database level (BUG-PRACTICE-005).  The earlier application-level
    pre-check raced: two concurrent calls could both pass the existence
    check and both insert.  We now rely on the constraint and surface
    the loser as 409 ``active_practice_exists_for_stage`` so the client
    gets a single deterministic response code regardless of timing.
    """
    practice = await _resolve_practice(session, payload.practice_id)
    await _check_stage_eligibility(session, current_user, practice, payload.stage_number)

    # ``start_date`` is the user-facing "I started this practice today"
    # label (BUG-HABIT-006), not an internal audit timestamp -- so it
    # uses the user's calendar, not server UTC.  A user in Pacific
    # signing up at 11:00 PM Pacific used to see "started tomorrow"
    # because UTC had already rolled over.
    user_tz = await get_user_timezone(session, current_user)
    user_practice = UserPractice(
        user_id=current_user,
        practice_id=payload.practice_id,
        stage_number=payload.stage_number,
        start_date=today_in_tz(user_tz),
    )
    session.add(user_practice)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        # The partial unique index fired because an open row already
        # exists for ``(current_user, stage_number)``.  Return 409 so
        # the client treats this as a state conflict, not a transient
        # bad request.
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


@router.get("/{user_practice_id}", response_model=UserPracticeDetail)
async def get_user_practice(
    session: Annotated[AsyncSession, Depends(get_session)],
    user_practice: Annotated[UserPractice, Depends(require_owned_user_practice)],
) -> dict[str, Any]:
    """Get a single user-practice with its session history.

    Ownership via ``require_owned_user_practice`` (404 → 403 split).
    """
    sessions_result = await session.execute(
        select(PracticeSession)
        .where(PracticeSession.user_practice_id == user_practice.id)
        .order_by(col(PracticeSession.timestamp).desc())
    )
    sessions = list(sessions_result.scalars().all())
    name, cfg = await _resolve_effective_fields(session, user_practice)

    return {
        **_user_practice_payload(user_practice),
        "effective_name": name,
        "effective_config": cfg,
        "sessions": sessions,
    }


def _validate_override_against_catalog(override: dict[str, Any] | None, practice: Practice) -> None:
    """Pre-flight validation: reject malformed or mode-mismatched overrides.

    Raises ``HTTPException`` directly so the endpoint short-circuits
    *before* persisting; without this guard, a bad override would land in
    the DB and the post-write resolver would 500. Pydantic's
    ``ValidationError`` is caught here and re-raised as a 422 with
    structured error details so the client can show field-level messages.
    Mode mismatch is mapped to a domain-meaningful 400.
    """
    if override is None:
        return
    try:
        cfg = ModeConfigAdapter.validate_python(override)
    except ValidationError as exc:
        # Preserve Pydantic's structured per-field errors so the client
        # can render field-level messages — ``unprocessable()`` only
        # accepts a string detail.
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
) -> dict[str, Any]:
    """Per-user override of name + mode_config.

    Both fields are nullable; passing ``None`` clears the override and
    falls back to the catalog value. Mode-shifting is rejected with
    400 ``mode_mismatch`` because mode changes are conceptually a
    practice replacement, not a tweak.
    """
    practice = await _resolve_practice(session, user_practice.practice_id)
    fields_set = payload.model_fields_set

    if "mode_config_override" in fields_set:
        _validate_override_against_catalog(payload.mode_config_override, practice)
        user_practice.mode_config_override = payload.mode_config_override
    if "custom_name" in fields_set:
        user_practice.custom_name = payload.custom_name

    session.add(user_practice)
    await session.commit()
    await session.refresh(user_practice)

    name = effective_name(practice, user_practice)
    cfg = effective_config(practice, user_practice).model_dump()

    sessions_result = await session.execute(
        select(PracticeSession)
        .where(PracticeSession.user_practice_id == user_practice.id)
        .order_by(col(PracticeSession.timestamp).desc())
    )
    sessions = list(sessions_result.scalars().all())
    logger.info(
        "user_practice_customized",
        extra={
            "user_practice_id": user_practice.id,
            "user_id": user_practice.user_id,
            "fields_changed": sorted(fields_set),
        },
    )
    return {
        **_user_practice_payload(user_practice),
        "effective_name": name,
        "effective_config": cfg,
        "sessions": sessions,
    }
