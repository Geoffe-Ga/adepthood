"""Shared SQLAlchemy eager-load options.

Centralizing these prevents drift in how related collections are loaded across
routers and services. Re-using the same option objects also lets reviewers
audit eager-loading at a glance: if a router imports ``HABIT_WITH_GOALS`` it
gets the canonical loader and won't accidentally drop a level of relationship
loading later.

Usage::

    from load_options import HABIT_WITH_GOALS_AND_COMPLETIONS

    statement = (
        select(Habit)
        .where(Habit.user_id == user_id)
        .options(HABIT_WITH_GOALS_AND_COMPLETIONS)
    )
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy.orm import selectinload
from sqlalchemy.orm.strategy_options import _AbstractLoad

from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.goal_group import GoalGroup
from models.habit import Habit

if TYPE_CHECKING:
    from datetime import datetime

# Habit -> goals (no completions).  Use when the response only exposes goal
# scalars (e.g. ``GET /habits``).
HABIT_WITH_GOALS: _AbstractLoad = selectinload(Habit.goals)  # type: ignore[arg-type]

# Habit -> goals -> completions.  Use whenever the caller iterates over
# completions (e.g. stats endpoints, stage history aggregation).
HABIT_WITH_GOALS_AND_COMPLETIONS: _AbstractLoad = HABIT_WITH_GOALS.selectinload(
    Goal.completions  # type: ignore[arg-type]
)


def habit_with_recent_completions(cutoff: datetime) -> _AbstractLoad:
    """Habit -> goals -> completions newer than ``cutoff`` (issue #294).

    The unbounded ``HABIT_WITH_GOALS_AND_COMPLETIONS`` chain ships an
    account's entire completion history on every habit GET — linear
    payload growth over the account's lifetime.  This windowed variant
    trims the *transport* via a query-time ``.and_()`` predicate; the
    rows themselves stay in the database and still feed the unwindowed
    consumers (the stats endpoint's all-time aggregates).  Built per
    request because ``cutoff`` is relative to now.
    """
    # ``attr-defined``: SQLModel types ``Goal.completions`` statically as
    # ``list[GoalCompletion]``; SQLAlchemy's relationship comparator adds
    # ``.and_`` at runtime — the same class-vs-instance attr quirk the
    # bare ``selectinload`` ignores above paper over (issue #294).
    return selectinload(Habit.goals).selectinload(  # type: ignore[arg-type]
        Goal.completions.and_(GoalCompletion.timestamp >= cutoff)  # type: ignore[attr-defined]
    )


# GoalGroup -> goals.  Use when serializing GoalGroupResponse, which embeds
# the group's goals.
GOAL_GROUP_WITH_GOALS: _AbstractLoad = selectinload(GoalGroup.goals)  # type: ignore[arg-type]
