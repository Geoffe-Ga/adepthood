from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import Column, DateTime, ForeignKey, Index
from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .goal import Goal


class GoalCompletion(SQLModel, table=True):
    """A log of one instance of a user's engagement with a goal.

    Each log records the number of completed units and whether it was
    tracked via timer.

    For additive goals, all logs in a day are summed, and the day is
    successful if total >= target.
    For subtractive goals, all logs in a day are summed, and the day is
    successful if total < target.
    """

    # ``ix_goalcompletion_goal_user_ts`` is created by migration
    # ``c1d2e3f4a5b6`` (issue #466).  Every streak/stats read filters on
    # ``goal_id`` / ``user_id`` and orders by ``timestamp``; this composite
    # index covers that hot path on the app's highest-write table.  Declared
    # here so the model and migration agree — ``alembic check`` otherwise
    # reports the index as drift and fails CI.
    __table_args__ = (Index("ix_goalcompletion_goal_user_ts", "goal_id", "user_id", "timestamp"),)

    id: int | None = Field(default=None, primary_key=True)
    goal_id: int = Field(
        sa_column=Column(ForeignKey("goal.id", ondelete="CASCADE"), nullable=False),
    )
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    timestamp: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    completed_units: float
    via_timer: bool = False
    goal: "Goal" = Relationship(back_populates="completions")
