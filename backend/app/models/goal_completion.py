from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .goal import Goal


class GoalCompletion(SQLModel, table=True):
    """
    A log of one instance of a user's engagement with a goal. Each log records
    the number of completed units and whether it was tracked via timer.

    For additive goals, all logs in a day are summed, and the day is
    successful if total >= target.
    For subtractive goals, all logs in a day are summed, and the day is
    successful if total < target.
    """

    id: int | None = Field(default=None, primary_key=True)
    goal_id: int = Field(foreign_key="goal.id")
    user_id: int = Field(foreign_key="user.id")
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))
    completed_units: float
    via_timer: bool = False
    goal: Goal = Relationship(back_populates="completions")
