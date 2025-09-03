from __future__ import annotations

from datetime import datetime

from sqlmodel import Field, SQLModel


class PracticeSession(SQLModel, table=True):
    """
    A single session log for a Practice the user is engaged with. Tracks duration
    and timestamp, allowing later evaluation of consistency.
    """

    id: int | None = Field(default=None, primary_key=True)
    user_practice_id: int = Field(foreign_key="userpractice.id")
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    duration_minutes: float
