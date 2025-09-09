"""Habit related schemas."""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel


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
    notification_frequency: str | None = None
    notification_days: list[str] | None = None
    milestone_notifications: bool = False
    sort_order: int | None = None


class HabitCreate(BaseModel):
    """Payload for creating/updating a habit."""

    user_id: int
    name: str
    icon: str
    start_date: date
    energy_cost: int
    energy_return: int
    notification_times: list[str] | None = None
    notification_frequency: str | None = None
    notification_days: list[str] | None = None
    milestone_notifications: bool = False
    sort_order: int | None = None
