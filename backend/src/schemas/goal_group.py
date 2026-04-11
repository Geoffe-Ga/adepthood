"""GoalGroup related schemas."""

from __future__ import annotations

from pydantic import BaseModel, Field

from schemas.goal import Goal

GOAL_GROUP_NAME_MAX_LENGTH = 255
GOAL_GROUP_ICON_MAX_LENGTH = 100
GOAL_GROUP_DESCRIPTION_MAX_LENGTH = 2_000
GOAL_GROUP_SOURCE_MAX_LENGTH = 255


class GoalGroupCreate(BaseModel):
    """Payload for creating/updating a goal group."""

    name: str = Field(min_length=1, max_length=GOAL_GROUP_NAME_MAX_LENGTH)
    icon: str | None = Field(default=None, max_length=GOAL_GROUP_ICON_MAX_LENGTH)
    description: str | None = Field(default=None, max_length=GOAL_GROUP_DESCRIPTION_MAX_LENGTH)
    shared_template: bool = False
    source: str | None = Field(default=None, max_length=GOAL_GROUP_SOURCE_MAX_LENGTH)


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
