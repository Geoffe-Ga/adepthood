"""GoalGroup related schemas."""

from __future__ import annotations

from pydantic import BaseModel

from schemas.goal import Goal


class GoalGroupCreate(BaseModel):
    """Payload for creating/updating a goal group."""

    name: str
    icon: str | None = None
    description: str | None = None
    shared_template: bool = False
    source: str | None = None


class GoalGroupResponse(BaseModel):
    """Public representation of a goal group with its goals."""

    id: int
    name: str
    icon: str | None = None
    description: str | None = None
    user_id: int | None = None
    shared_template: bool = False
    source: str | None = None
    goals: list[Goal] = []
