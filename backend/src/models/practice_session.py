from datetime import UTC, datetime

from sqlmodel import Field, SQLModel


class PracticeSession(SQLModel, table=True):
    """
    A single session log for a Practice the user is engaged with. Tracks duration
    and timestamp, allowing later evaluation of consistency.
    """

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id")
    practice_id: int
    stage_number: int
    duration_minutes: float
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))
    reflection: str | None = None
