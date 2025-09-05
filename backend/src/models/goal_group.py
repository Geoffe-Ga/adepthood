from __future__ import annotations

from typing import TYPE_CHECKING

from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .goal import Goal


class GoalGroup(SQLModel, table=True):
    """Logical grouping for related goals."""

    id: int | None = Field(default=None, primary_key=True)
    name: str
    icon: str | None = None
    description: str | None = None
    user_id: int | None = Field(default=None, foreign_key="user.id")
    shared_template: bool = False
    source: str | None = None
    goals: list[Goal] = Relationship(back_populates="goal_group")
