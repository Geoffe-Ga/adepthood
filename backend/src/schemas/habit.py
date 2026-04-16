"""Habit related schemas."""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field

from schemas.goal import Goal

NOTIFICATION_FREQUENCY = Literal["daily", "weekly", "custom", "off"]

HABIT_NAME_MAX_LENGTH = 255
HABIT_ICON_MAX_LENGTH = 100
HABIT_STAGE_MAX_LENGTH = 100


class Habit(BaseModel):
    """Public representation of a :class:`models.habit.Habit`.

    Mirrors the SQLModel definition so API consumers can rely on a stable
    contract. Includes notification fields and client-controlled sort order.
    """

    id: int
    user_id: int
    name: str
    icon: str
    start_date: date
    energy_cost: int
    energy_return: int
    notification_times: list[str] | None = None
    notification_frequency: NOTIFICATION_FREQUENCY | None = None
    notification_days: list[str] | None = None
    milestone_notifications: bool = False
    sort_order: int | None = None
    stage: str = ""
    streak: int = 0


class HabitWithGoals(Habit):
    """Habit response that includes nested goals."""

    goals: list[Goal] = []


class HabitCreate(BaseModel):
    """Payload for creating/updating a habit.

    ``user_id`` is intentionally omitted — the server derives it from the
    authenticated user's token so clients cannot impersonate other users.
    """

    name: str = Field(min_length=1, max_length=HABIT_NAME_MAX_LENGTH)
    icon: str = Field(max_length=HABIT_ICON_MAX_LENGTH)
    start_date: date
    energy_cost: int = Field(ge=0, le=1000)
    energy_return: int = Field(ge=0, le=1000)
    notification_times: list[str] | None = None
    notification_frequency: NOTIFICATION_FREQUENCY | None = None
    notification_days: list[str] | None = None
    milestone_notifications: bool = False
    sort_order: int | None = None
    stage: str = Field(default="", max_length=HABIT_STAGE_MAX_LENGTH)
