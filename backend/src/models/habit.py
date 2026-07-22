from datetime import date
from typing import TYPE_CHECKING

from sqlalchemy import Column
from sqlalchemy.dialects.postgresql import ARRAY as PG_ARRAY
from sqlalchemy.types import String
from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .goal import Goal
    from .user import User


class Habit(SQLModel, table=True):
    """Tracks a user's habit and related goals.

    ``revealed`` is the single source of truth for whether a habit is unlocked
    ("unlocked" == ``revealed is True`` in product terms). New and seeded
    habits default to locked; the user opts each one in. Re-locking (flipping
    ``revealed`` back to ``False``) preserves logged completions — those live
    on the habit's goals, never on this flag — so a re-locked habit keeps its
    history for when the user unlocks it again.

    ``is_carryover`` marks a habit the user brought into APTITUDE from before
    the program: ``True`` keeps it on its own partition (tracked without
    consuming a program stage), ``False`` a regular program habit.
    """

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(max_length=255)
    icon: str = Field(max_length=100)
    start_date: date
    energy_cost: int
    energy_return: int
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    notification_times: list[str] | None = Field(
        default=None, sa_column=Column(PG_ARRAY(String), nullable=True)
    )
    notification_frequency: str | None = Field(default=None, max_length=20)
    notification_days: list[str] | None = Field(
        default=None, sa_column=Column(PG_ARRAY(String), nullable=True)
    )
    milestone_notifications: bool = Field(default=False)
    sort_order: int | None = None
    stage: str = Field(default="", max_length=100)
    streak: int = 0
    revealed: bool = Field(default=False)
    is_carryover: bool = Field(default=False)
    user: "User" = Relationship(back_populates="habits")
    goals: list["Goal"] = Relationship(
        back_populates="habit",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )
