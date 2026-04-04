"""Practice session API endpoints backed by the database."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import func, select

from database import get_session
from models.practice_session import PracticeSession
from routers.auth import get_current_user
from schemas.practice import PracticeSessionCreate, PracticeSessionSchema

router = APIRouter(prefix="/practice_sessions", tags=["practice"])


@router.post("/", response_model=PracticeSessionSchema)
async def create_session(
    payload: PracticeSessionCreate,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> PracticeSession:
    """Store a practice session and return it."""
    practice_session = PracticeSession(user_id=current_user, **payload.model_dump())
    session.add(practice_session)
    await session.commit()
    await session.refresh(practice_session)
    return practice_session


@router.get("/week_count")
async def week_count(
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> dict[str, int]:
    """Return the number of sessions the authenticated user completed this week.

    .. note:: Uses server UTC time. A ``timezone`` query parameter could be
       added in the future so the start-of-week is calculated in the user's
       local time.  # TODO: accept timezone param for local week boundary
    """
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
