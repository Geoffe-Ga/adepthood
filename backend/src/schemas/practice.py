"""Practice session related schemas."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class PracticeSessionSchema(BaseModel):
    """Public representation of a practice session."""

    id: int
    user_id: int
    practice_id: int
    stage_number: int
    duration_minutes: float
    timestamp: datetime
    reflection: str | None = None


class PracticeSessionCreate(BaseModel):
    """Payload for creating a new practice session.

    ``user_id`` is intentionally omitted — the server derives it from the
    authenticated user's token so clients cannot impersonate other users.
    """

    practice_id: int
    stage_number: int
    duration_minutes: float
    reflection: str | None = None
