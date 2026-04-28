"""GoalGroup related schemas."""

from __future__ import annotations

from pydantic import BaseModel, Field

from schemas._base import OwnedResourcePublic
from schemas.goal import Goal

GOAL_GROUP_NAME_MAX_LENGTH = 255
GOAL_GROUP_ICON_MAX_LENGTH = 100
GOAL_GROUP_DESCRIPTION_MAX_LENGTH = 2_000
GOAL_GROUP_SOURCE_MAX_LENGTH = 255


class GoalGroupCreate(BaseModel):
    """Payload for creating/updating a goal group.

    ``user_id`` is intentionally absent — the server derives ownership from
    ``current_user`` (BUG-GOAL-005), so a forged payload field is silently
    ignored.  ``shared_template=True`` flips the row to a public template
    with ``user_id IS NULL``; non-shared rows are owned by the caller.
    """

    name: str = Field(min_length=1, max_length=GOAL_GROUP_NAME_MAX_LENGTH)
    icon: str | None = Field(default=None, max_length=GOAL_GROUP_ICON_MAX_LENGTH)
    description: str | None = Field(default=None, max_length=GOAL_GROUP_DESCRIPTION_MAX_LENGTH)
    shared_template: bool = False
    source: str | None = Field(default=None, max_length=GOAL_GROUP_SOURCE_MAX_LENGTH)


class GoalGroupResponse(OwnedResourcePublic):
    """Public representation of a goal group with its goals.

    ``user_id`` is intentionally excluded (BUG-T7 / BUG-GOAL-006): clients
    distinguish their own private groups from public templates via the
    ``shared_template`` flag rather than a surrogate user key.  The list
    endpoint already filters to ``user_id == current_user OR shared_template``,
    so any non-shared row in a response is by definition owned by the caller.
    """

    id: int
    name: str
    icon: str | None = None
    description: str | None = None
    shared_template: bool = False
    source: str | None = None
    goals: list[Goal] = Field(default_factory=list)
