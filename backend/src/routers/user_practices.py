"""User-practices API — select a practice per stage and view selections."""

from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from dependencies.ownership import require_owned_user_practice
from domain.dates import today_in_tz
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
    UserPracticeDetail,
    UserPracticeResponse,
)
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
    serialized = [UserPracticeResponse.model_validate(u, from_attributes=True) for u in items]
    if pagination.paginate:
        return build_page(serialized, total, pagination)
    return serialized


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

    return {
        "id": user_practice.id,
        "practice_id": user_practice.practice_id,
        "stage_number": user_practice.stage_number,
        "start_date": user_practice.start_date,
        "end_date": user_practice.end_date,
        "sessions": sessions,
    }
