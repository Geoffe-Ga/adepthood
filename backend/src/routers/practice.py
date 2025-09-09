from __future__ import annotations

from datetime import UTC, datetime, timedelta
from itertools import count

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from routers.auth import get_current_user


class PracticeSession(BaseModel):
    """Represents one timed practice session performed by a user."""

    id: int
    user_id: int
    practice_id: int
    stage_number: int
    duration_minutes: float
    timestamp: datetime
    reflection: str | None = None


class PracticeSessionCreate(BaseModel):
    """Payload for creating a new practice session."""

    user_id: int
    practice_id: int
    stage_number: int
    duration_minutes: float
    reflection: str | None = None


router = APIRouter(prefix="/practice_sessions", tags=["practice"])
_sessions: list[PracticeSession] = []
_id_counter = count(1)


@router.post("/", response_model=PracticeSession)
def create_session(
    payload: PracticeSessionCreate, current_user: int = Depends(get_current_user)
) -> PracticeSession:
    """Store a practice session in memory and return it."""
    if payload.user_id != current_user:
        raise HTTPException(403, "cannot create for another user")
    session = PracticeSession(
        id=next(_id_counter),
        timestamp=datetime.now(UTC),
        **payload.model_dump(),
    )
    _sessions.append(session)
    return session


@router.get("/{user_id}/week_count")
def week_count(user_id: int, current_user: int = Depends(get_current_user)) -> dict[str, int]:
    """Return the number of sessions a user has completed this week."""
    if user_id != current_user:
        raise HTTPException(403, "cannot view another user")
    now = datetime.now(UTC)
    start_of_week = now - timedelta(days=now.weekday())
    count = sum(1 for s in _sessions if s.user_id == user_id and s.timestamp >= start_of_week)
    return {"count": count}
