"""Goal completion related schemas."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class GoalCompletion(BaseModel):
    """Public representation of a :class:`models.goal_completion.GoalCompletion`."""

    id: int
    goal_id: int
    user_id: int
    timestamp: datetime
    completed_units: float
    via_timer: bool = False


class GoalCompletionCreate(BaseModel):
    """Payload for recording a goal completion."""

    goal_id: int
    user_id: int
    timestamp: datetime | None = None
    completed_units: float
    via_timer: bool = False
