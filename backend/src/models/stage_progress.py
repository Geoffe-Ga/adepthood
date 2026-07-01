from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import CheckConstraint, Column, DateTime, Integer
from sqlalchemy.dialects.postgresql import ARRAY
from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .user import User


class StageProgress(SQLModel, table=True):
    """Tracks which stage a user is currently working on and which stages have been completed."""

    __table_args__ = (
        CheckConstraint("cycle_number >= 1", name="ck_stageprogress_cycle_number_positive"),
    )

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
    # Program-wide start anchor (issue #386): the single date every
    # stage/week calendar derivation keys off, mirroring the frontend's
    # ``programStartDate``.  Nullable for legacy rows; the migration
    # backfills from the earliest habit start date (else
    # ``stage_started_at``), and ``resolve_program_anchor`` falls back at
    # read time for anything the backfill missed.
    program_started_at: datetime | None = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    # Loop index for the 36-week arc; progression/loop logic lands in a later issue.
    cycle_number: int = Field(default=1, ge=1)
    user_id: int = Field(foreign_key="user.id", unique=True, ondelete="CASCADE")
    user: "User" = Relationship(back_populates="stage_progress")
