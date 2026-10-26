"""Append-only provenance for unit changes to a goal's daily aggregate."""

from datetime import UTC, date, datetime
from enum import StrEnum

from sqlalchemy import CheckConstraint, Column, DateTime, Index
from sqlmodel import Field, SQLModel


class GoalLogSource(StrEnum):
    """The check-in path that produced a unit change."""

    MANUAL = "manual"
    TIMER = "timer"
    JOURNAL = "journal"
    PRACTICE_LINK = "practice_link"
    BACKFILL = "backfill"


_SOURCE_CONSTRAINT_SQL = "source IN ({})".format(
    ", ".join(f"'{source.value}'" for source in GoalLogSource)
)


class GoalLogEvent(SQLModel, table=True):
    """One actual signed unit change, stamped when the server records it.

    Events are never reconstructed from historical daily aggregates. A day
    with units but no events predates this table: its time of day is unknown,
    not the aggregate's timestamp, which records a last write. An undo appends
    a negative event; no event is updated or deleted by a check-in.
    """

    __table_args__ = (
        CheckConstraint(_SOURCE_CONSTRAINT_SQL, name="ck_goallogevent_source_valid"),
        CheckConstraint("delta_units != 0", name="ck_goallogevent_delta_nonzero"),
        Index("ix_goallogevent_goal_user_ts", "goal_id", "user_id", "timestamp"),
    )

    id: int | None = Field(default=None, primary_key=True)
    goal_id: int = Field(foreign_key="goal.id", ondelete="CASCADE")
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    timestamp: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    local_day: date
    delta_units: float
    via_timer: bool = False
    source: str = Field(max_length=32)
