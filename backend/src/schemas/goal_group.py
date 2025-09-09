"""Goal group related schemas."""

from __future__ import annotations

from pydantic import BaseModel


class GoalGroup(BaseModel):
    """Public representation of a :class:`models.goal_group.GoalGroup`."""

    id: int
    name: str
    icon: str | None = None
    description: str | None = None
    user_id: int | None = None
    shared_template: bool = False
    source: str | None = None
