from typing import TYPE_CHECKING

from sqlalchemy import CheckConstraint
from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .goal import Goal


class GoalGroup(SQLModel, table=True):
    """Logical grouping for related goals.

    Invariant: shared templates (``shared_template=True``) must have
    ``user_id IS NULL``, and user-owned groups must have a non-null
    ``user_id``.  Enforced at the DB level via a CHECK constraint.
    """

    __table_args__ = (
        CheckConstraint(
            "(shared_template = true AND user_id IS NULL) "
            "OR (shared_template = false AND user_id IS NOT NULL)",
            name="ck_goalgroup_shared_template_user_id",
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(max_length=255)
    icon: str | None = Field(default=None, max_length=100)
    description: str | None = Field(default=None, max_length=2_000)
    user_id: int | None = Field(default=None, foreign_key="user.id", ondelete="SET NULL")
    shared_template: bool = False
    source: str | None = Field(default=None, max_length=255)
    goals: list["Goal"] = Relationship(back_populates="goal_group")
