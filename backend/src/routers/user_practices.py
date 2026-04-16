"""User-practices API — select a practice per stage and view selections."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from errors import bad_request, forbidden, not_found
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

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/user-practices", tags=["user-practices"])


@router.post("/", response_model=UserPracticeResponse, status_code=status.HTTP_201_CREATED)
async def create_user_practice(
    payload: UserPracticeCreate,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> UserPractice:
    """Select a practice for a stage, creating a UserPractice record."""
    # Verify practice exists and is approved
    result = await session.execute(select(Practice).where(Practice.id == payload.practice_id))
    practice = result.scalars().first()
    if practice is None:
        raise not_found("practice")
    if not practice.approved:
        raise bad_request("practice_not_approved")

    # BUG-PRACTICE-011: prevent multiple active practices for the same stage
    existing = await session.execute(
        select(UserPractice.id).where(
            UserPractice.user_id == current_user,
            UserPractice.stage_number == payload.stage_number,
            UserPractice.end_date.is_(None),  # type: ignore[union-attr]
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise bad_request("active_practice_exists_for_stage")

    user_practice = UserPractice(
        user_id=current_user,
        practice_id=payload.practice_id,
        stage_number=payload.stage_number,
        start_date=datetime.now(UTC).date(),
    )
    session.add(user_practice)
    await session.commit()
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
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
    pagination: PaginationParams = Depends(),  # noqa: B008
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
    user_practice_id: int,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> dict[str, Any]:
    """Get a single user-practice with its session history."""
    result = await session.execute(select(UserPractice).where(UserPractice.id == user_practice_id))
    user_practice = result.scalars().first()
    if user_practice is None:
        raise not_found("user_practice")
    if user_practice.user_id != current_user:
        raise forbidden()

    sessions_result = await session.execute(
        select(PracticeSession)
        .where(PracticeSession.user_practice_id == user_practice_id)
        .order_by(col(PracticeSession.timestamp).desc())
    )
    sessions = list(sessions_result.scalars().all())

    return {
        "id": user_practice.id,
        "user_id": user_practice.user_id,
        "practice_id": user_practice.practice_id,
        "stage_number": user_practice.stage_number,
        "start_date": user_practice.start_date,
        "end_date": user_practice.end_date,
        "sessions": sessions,
    }
