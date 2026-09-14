"""Habit related schemas."""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from bounds import CountField
from schemas._base import OwnedResourcePublic
from schemas.goal import GoalWithCompletions
from security import sanitize_user_text

NOTIFICATION_FREQUENCY = Literal["daily", "weekly", "custom", "off"]

HABIT_NAME_MAX_LENGTH = 255
HABIT_ICON_MAX_LENGTH = 100
HABIT_STAGE_MAX_LENGTH = 100


class Habit(OwnedResourcePublic):
    """Public representation of a :class:`models.habit.Habit`.

    Mirrors the SQLModel definition so API consumers can rely on a stable
    contract. Includes notification fields and client-controlled sort order.

    ``user_id`` is intentionally excluded (BUG-HABIT-001 / BUG-SCHEMA-001):
    the client already knows its own identity from the JWT, so emitting
    surrogate user keys only aids enumeration.
    """

    id: int
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
    revealed: bool = False
    is_carryover: bool = False


class HabitWithGoals(Habit):
    """Habit + nested goals each carrying their embedded completions (BUG-FE-HABIT-301)."""

    goals: list[GoalWithCompletions] = Field(default_factory=list)


class HabitCreate(BaseModel):
    """Payload for creating/updating a habit.

    ``user_id`` is intentionally omitted — the server derives it from the
    authenticated user's token so clients cannot impersonate other users.
    """

    # JSON Schema cannot express "non-empty after control/zero-width stripping".
    # Keep the published one-character floor while the router performs the
    # authoritative sanitization and returns one stable refusal for every
    # invisible spelling, including a raw empty string.
    name: str = Field(
        max_length=HABIT_NAME_MAX_LENGTH,
        json_schema_extra={"minLength": 1},
    )
    icon: str = Field(max_length=HABIT_ICON_MAX_LENGTH)
    start_date: date
    energy_cost: int = Field(ge=0, le=1000)
    energy_return: int = Field(ge=0, le=1000)
    notification_times: list[str] | None = None
    notification_frequency: NOTIFICATION_FREQUENCY | None = None
    notification_days: list[str] | None = None
    milestone_notifications: bool = False
    sort_order: CountField | None = None
    stage: str = Field(default="", max_length=HABIT_STAGE_MAX_LENGTH)
    revealed: bool = False
    is_carryover: bool = False

    @field_validator("name", mode="before")
    @classmethod
    def _canonical_name(cls, value: object) -> object:
        """Canonicalize textual names before the declared length constraint."""
        if not isinstance(value, str):
            return value
        return sanitize_user_text(value, max_len=HABIT_NAME_MAX_LENGTH)
