"""Habit related schemas."""

from __future__ import annotations

from datetime import date
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

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


# Bounds mirror :class:`schemas.goal.GoalUnitsUpdate`.
GOAL_UNIT_MAX_LENGTH = 50


class HabitGoalsCreate(BaseModel):
    """The three goal tiers a link flow creates a habit with (#3150).

    One unit and cadence shared by every tier -- the same shape
    ``PUT /habits/{id}/goals/units`` edits -- plus each tier's target. The
    journal link sends ``minutes`` 10 / 20 / 45 per day; the practice link
    ``sessions`` 1 / 1 / 2, four per week. Targets climb: ``low <= clear <=
    stretch``. Every number is strictly positive, because a timer never logs
    a zero-minute or zero-session goal. Which units are allowed is decided by
    :mod:`domain.habit_links`, not here, so the rule has one home.
    """

    model_config = ConfigDict(extra="forbid")

    target_unit: str = Field(min_length=1, max_length=GOAL_UNIT_MAX_LENGTH)
    frequency: float = Field(gt=0, allow_inf_nan=False)
    frequency_unit: str = Field(min_length=1, max_length=GOAL_UNIT_MAX_LENGTH)
    low: float = Field(gt=0, allow_inf_nan=False)
    clear: float = Field(gt=0, allow_inf_nan=False)
    stretch: float = Field(gt=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def _tiers_climb(self) -> Self:
        """Refuse tiers that do not climb from low through clear to stretch."""
        if not self.low <= self.clear <= self.stretch:
            msg = "goal tiers must satisfy low <= clear <= stretch"
            raise ValueError(msg)
        return self

    def tier_targets(self) -> dict[str, float]:
        """Each tier's target, keyed by tier name."""
        return {"low": self.low, "clear": self.clear, "stretch": self.stretch}


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
    # Create-only (#3150): the habit's three goal tiers, for a link flow that
    # creates the habit and its timer goals in one request. Omitted, a new
    # habit gets the 1 / 2 / 3 ``units`` per day defaults. ``PUT`` refuses it
    # with 422 ``habit_goals_create_only``; tiers are edited through the goals
    # endpoints instead.
    goals: HabitGoalsCreate | None = None

    @field_validator("name", mode="before")
    @classmethod
    def _canonical_name(cls, value: object) -> object:
        """Canonicalize textual names before the declared length constraint."""
        if not isinstance(value, str):
            return value
        return sanitize_user_text(value, max_len=HABIT_NAME_MAX_LENGTH)
