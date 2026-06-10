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


def habit_with_recent_completions(cutoff: datetime, user_id: int) -> _AbstractLoad:
    """Habit -> goals -> caller-owned completions newer than ``cutoff``.

    Two query-time predicates, one loader:

    * ``timestamp >= cutoff`` (issue #294) bounds the transport so habit
      GET payloads stop growing with account age.  Rows stay in the DB
      and still feed the unwindowed stats consumers.
    * ``user_id`` (issue #296) replaces the old in-memory
      ``_filter_completions_to_caller``, whose collection replacement
      marked cross-tenant rows for a ``goal_id=NULL`` flush — a
      data-loss/IntegrityError footgun for any write issued after a GET.
      Filtering in SQL means the ORM relation is never mutated in Python
      and misuse is impossible by construction.

    Built per request: ``cutoff`` is relative to now and ``user_id`` is
    the caller.
    """
    # ``attr-defined``: SQLModel types ``Goal.completions`` statically as
    # ``list[GoalCompletion]``; SQLAlchemy's relationship comparator adds
    # ``.and_`` at runtime — the same class-vs-instance attr quirk the
    # bare ``selectinload`` ignores above paper over (issue #294).
    return selectinload(Habit.goals).selectinload(  # type: ignore[arg-type]
        Goal.completions.and_(  # type: ignore[attr-defined]
            (GoalCompletion.timestamp >= cutoff) & (GoalCompletion.user_id == user_id)
        )
    )


# GoalGroup -> goals.  Use when serializing GoalGroupResponse, which embeds
# the group's goals.
GOAL_GROUP_WITH_GOALS: _AbstractLoad = selectinload(GoalGroup.goals)  # type: ignore[arg-type]
