from typing import TYPE_CHECKING, Optional

from sqlalchemy import Column, ForeignKey, String
from sqlalchemy.dialects.postgresql import ARRAY as PG_ARRAY
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
    habit_id: int = Field(
        sa_column=Column(ForeignKey("habit.id", ondelete="CASCADE"), nullable=False),
    )
    title: str = Field(max_length=255)
    description: str | None = Field(default=None, max_length=2_000)
    tier: str = Field(max_length=50)  # "low", "clear", "stretch"
    target: float
    target_unit: str = Field(max_length=50)  # "minutes", "reps", etc.
    frequency: float  # e.g. 2.0 = 2x per frequency_unit
    frequency_unit: str = Field(max_length=50)  # "per_day", "per_week"
    days_of_week: list[str] | None = Field(
        default=None,
        sa_column=Column(PG_ARRAY(String), nullable=True),
    )
    track_with_timer: bool = False
    timer_duration_minutes: int | None = None
    origin: str | None = Field(default=None, max_length=255)
    goal_group_id: int | None = Field(default=None, foreign_key="goalgroup.id")
    goal_group: Optional["GoalGroup"] = Relationship(back_populates="goals")
    is_additive: bool = True
    habit: "Habit" = Relationship(back_populates="goals")
    completions: list["GoalCompletion"] = Relationship(back_populates="goal")
