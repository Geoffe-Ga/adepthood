from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import Column, String
from sqlalchemy.dialects.postgresql import ARRAY
from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .goal_completion import GoalCompletion
    from .goal_group import GoalGroup
    from .habit import Habit


class Goal(SQLModel, table=True):
    """
    Represents a single target for a habit, defined by a measurable unit
    (target_unit) and frequency (frequency_unit). Goals can be additive
    (e.g. drink 8 cups of water) or subtractive (e.g. limit caffeine to 200mg).

    Use is_additive = True for goals where success is defined by reaching or
    exceeding the target. Use is_additive = False for goals where success is
    defined by staying under the target.

    When multiple goals share the same target_unit and are part of a tiered
    system (e.g. low, clear, stretch), they should be grouped using
    goal_group_id. This allows the system to evaluate all tiers together based on
    the same logged completions.
    """

    id: int | None = Field(default=None, primary_key=True)
    habit_id: int = Field(foreign_key="habit.id")
    title: str
    description: str | None = None
    tier: str  # "low", "clear", "stretch"
    target: float
    target_unit: str  # "minutes", "reps", etc.
    frequency: float  # e.g. 2.0 = 2x per frequency_unit
    frequency_unit: str  # "per_day", "per_week"
    days_of_week: list[str] | None = Field(
        default=None,
        sa_column=Column(ARRAY(String), nullable=True),
    )
    track_with_timer: bool = False
    timer_duration_minutes: int | None = None
    origin: str | None = None
    goal_group_id: int | None = Field(default=None, foreign_key="goalgroup.id")
    goal_group: GoalGroup | None = Relationship(back_populates="goals")
    is_additive: bool = True
    habit: Habit = Relationship(back_populates="goals")
    completions: list[GoalCompletion] = Relationship(back_populates="goal")
