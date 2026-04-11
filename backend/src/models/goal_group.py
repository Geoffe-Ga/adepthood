from typing import TYPE_CHECKING

from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .goal import Goal


class GoalGroup(SQLModel, table=True):
    """Logical grouping for related goals."""

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(max_length=255)
    icon: str | None = Field(default=None, max_length=100)
    description: str | None = Field(default=None, max_length=2_000)
    user_id: int | None = Field(default=None, foreign_key="user.id")
    shared_template: bool = False
    source: str | None = Field(default=None, max_length=255)
    goals: list["Goal"] = Relationship(back_populates="goal_group")
