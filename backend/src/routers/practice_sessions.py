"""Practice session API — log sessions linked to UserPractice selections."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, func, select

from database import get_session
from errors import forbidden, not_found
from models.practice_session import PracticeSession
from models.user_practice import UserPractice
from routers.auth import get_current_user
from schemas import Page, PaginationParams, build_page
from schemas.pagination import paginate_query
from schemas.practice import PracticeSessionCreate, PracticeSessionResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/practice-sessions", tags=["practice-sessions"])


@router.post("/", response_model=PracticeSessionResponse)
async def create_session(
    payload: PracticeSessionCreate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PracticeSession:
    """Log a practice session against a user-practice selection."""
    result = await session.execute(
        select(UserPractice).where(UserPractice.id == payload.user_practice_id)
    )
    user_practice = result.scalars().first()
    if user_practice is None:
        raise not_found("user_practice")
    if user_practice.user_id != current_user:
        raise forbidden()

    duration_minutes = payload.duration_minutes
    practice_session = PracticeSession(
        user_id=current_user,
        user_practice_id=payload.user_practice_id,
        duration_minutes=duration_minutes,
        reflection=payload.reflection,
        timestamp=payload.ended_at,
    )
    session.add(practice_session)
    await session.commit()
    await session.refresh(practice_session)
    logger.info(
        "practice_session_logged",
        extra={
            "user_id": current_user,
            "user_practice_id": payload.user_practice_id,
            "duration_minutes": duration_minutes,
        },
    )
    return practice_session


@router.get("/", response_model=None)
async def list_sessions(
    user_practice_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    pagination: Annotated[PaginationParams, Depends()],
) -> Page[PracticeSessionResponse] | list[PracticeSessionResponse]:
    """List sessions for a specific user-practice, newest first.

    BUG-INFRA-014: returns ``Page[PracticeSessionResponse]`` when
    ``?paginate=true`` is set; otherwise the legacy bare list is returned
    for one release while the frontend migrates to the envelope.
    """
    query = (
        select(PracticeSession)
        .where(
            PracticeSession.user_practice_id == user_practice_id,
            PracticeSession.user_id == current_user,
        )
        .order_by(col(PracticeSession.timestamp).desc())
    )
    items, total = await paginate_query(session, query, pagination)
    serialized = [PracticeSessionResponse.model_validate(s, from_attributes=True) for s in items]
    if pagination.paginate:
        return build_page(serialized, total, pagination)
    return serialized


@router.get("/week-count")
async def week_count(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, int]:
    """Return the number of sessions the authenticated user completed this week."""
    now = datetime.now(UTC)
    start_of_week = now - timedelta(days=now.weekday())
    start_of_week = start_of_week.replace(hour=0, minute=0, second=0, microsecond=0)
    statement = select(func.count()).where(
        PracticeSession.user_id == current_user,
        PracticeSession.timestamp >= start_of_week,
    )
    result = await session.execute(statement)
    count = result.scalar_one()
    return {"count": count}
