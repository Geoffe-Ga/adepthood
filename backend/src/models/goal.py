from enum import StrEnum
from typing import TYPE_CHECKING, Optional

from sqlalchemy import CheckConstraint, Column, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import ARRAY as PG_ARRAY
from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .goal_completion import GoalCompletion
    from .goal_group import GoalGroup
    from .habit import Habit


class GoalTier(StrEnum):
    """Allowed tier values for a Goal."""

    LOW = "low"
    CLEAR = "clear"
    STRETCH = "stretch"


# The name migration ``c3d4e5f6a7b8`` creates the tier CHECK constraint under.
# The model must declare it under the same name: a differently-named constraint
# with identical semantics still reads to Alembic's autogenerate as one dropped
# and one added.
TIER_CONSTRAINT_NAME = "ck_goal_tier_valid"

# Rendered from :class:`GoalTier` rather than restated, so adding a tier to the
# enum cannot leave the constraint silently bounding the old set. The rendered
# text matches the migration's literal ``tier IN ('low', 'clear', 'stretch')``.
_TIER_CONSTRAINT_SQL = "tier IN ({})".format(", ".join(f"'{tier.value}'" for tier in GoalTier))


class Goal(SQLModel, table=True):
    """Represents a single measurable target for a habit.

    Defined by a target unit (target_unit) and frequency (frequency_unit).
    Goals can be additive (e.g. drink 8 cups of water) or subtractive
    (e.g. limit caffeine to 200mg).

    Use is_additive = True for goals where success is defined by reaching or
    exceeding the target. Use is_additive = False for goals where success is
    defined by staying under the target.

    When multiple goals share the same target_unit and are part of a tiered
    system (e.g. low, clear, stretch), they should be grouped using
    goal_group_id. This allows the system to evaluate all tiers together based on
    the same logged completions.

    ``tier`` is bounded to the :class:`GoalTier` members by a CHECK constraint
    declared in ``__table_args__``. The constraint has existed in Postgres since
    migration ``c3d4e5f6a7b8`` (BUG-GOAL-006); declaring it here is what makes
    the model an accurate account of the table, which is the thing Alembic's
    autogenerate compares against. It also means the SQLite test fixture builds
    the constraint too, so a bad tier fails in tests rather than only in
    production.
    """

    __table_args__ = (CheckConstraint(_TIER_CONSTRAINT_SQL, name=TIER_CONSTRAINT_NAME),)

    id: int | None = Field(default=None, primary_key=True)
    habit_id: int = Field(
        sa_column=Column(ForeignKey("habit.id", ondelete="CASCADE"), nullable=False),
    )
    title: str = Field(max_length=255)
    description: str | None = Field(default=None, max_length=2_000)
    tier: str = Field(max_length=50)  # validated as GoalTier at the schema layer
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
    goal_group_id: int | None = Field(
        default=None,
        sa_column=Column(
            Integer,
            ForeignKey("goalgroup.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    goal_group: Optional["GoalGroup"] = Relationship(back_populates="goals")
    is_additive: bool = True
    habit: "Habit" = Relationship(back_populates="goals")
    completions: list["GoalCompletion"] = Relationship(back_populates="goal")
