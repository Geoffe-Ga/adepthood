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
    """Tracks a user's habit and related goals."""

    id: int | None = Field(default=None, primary_key=True)
    name: str
    icon: str
    start_date: date
    energy_cost: int
    energy_return: int
    user_id: int = Field(foreign_key="user.id")
    notification_times: list[str] | None = Field(
        default=None, sa_column=Column(PG_ARRAY(String), nullable=True)
    )
    notification_frequency: str | None = None
    notification_days: list[str] | None = Field(
        default=None, sa_column=Column(PG_ARRAY(String), nullable=True)
    )
    milestone_notifications: bool = Field(default=False)
    sort_order: int | None = None
    user: "User" = Relationship(back_populates="habits")
    goals: list["Goal"] = Relationship(back_populates="habit")
