from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import Column, DateTime, Integer
from sqlalchemy.dialects.postgresql import ARRAY
from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .user import User


class StageProgress(SQLModel, table=True):
    """Tracks which stage a user is currently working on and which stages have been completed."""

    id: int | None = Field(default=None, primary_key=True)
    current_stage: int
    completed_stages: list[int] = Field(
        default_factory=list,
        sa_column=Column(ARRAY(Integer), nullable=False),
    )
    stage_started_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    user_id: int = Field(foreign_key="user.id", unique=True)
    user: "User" = Relationship(back_populates="stage_progress")
