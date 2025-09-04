from __future__ import annotations

from datetime import date
from typing import TYPE_CHECKING

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
    user: User = Relationship(back_populates="habits")
    goals: list[Goal] = Relationship(back_populates="habit")
