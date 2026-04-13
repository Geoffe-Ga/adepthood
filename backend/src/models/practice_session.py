from datetime import UTC, datetime

from sqlalchemy import Column, DateTime
from sqlmodel import Field, SQLModel


class PracticeSession(SQLModel, table=True):
    """A single session log linked to a UserPractice selection.

    Sessions track duration and timestamp for consistency evaluation
    (target: minimum 4x/week).
    """

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id")
    user_practice_id: int = Field(foreign_key="userpractice.id")
    duration_minutes: float
    timestamp: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    reflection: str | None = Field(default=None, max_length=5_000)
