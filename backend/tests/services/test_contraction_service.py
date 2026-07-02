"""Integration tests for :mod:`services.contraction` -- read-only aggregate gathering.

These tests FAIL until ``backend/src/services/contraction.py`` exists with the
contract pinned below. That is the correct RED state for Gate 1.

Pinned service contract:
  async def gather_contraction_aggregates(session, user_id, user_timezone="UTC")
      -> ContractionAggregates
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.contraction import (
    FOUNDATION_UNCHECKED_CONSECUTIVE_DAYS,
    FOUNDATION_UNMET_CONSECUTIVE_DAYS,
)
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.user import User
from services.contraction import gather_contraction_aggregates

_WINDOW = max(FOUNDATION_UNMET_CONSECUTIVE_DAYS, FOUNDATION_UNCHECKED_CONSECUTIVE_DAYS)


async def _make_user(session: AsyncSession, email: str = "contraction@example.com") -> int:
    """Insert a User row and return its id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.commit()
    await session.refresh(user)
    assert user.id is not None
    return user.id


async def _make_habit(
    session: AsyncSession,
    user_id: int,
    *,
    name: str = "Meditate",
    start_date: date | None = None,
) -> int:
    """Seed a Habit row (start_date well before the window) and return its id."""
    habit = Habit(
        name=name,
        icon="flame",
        start_date=start_date or (datetime.now(UTC).date() - timedelta(days=_WINDOW + 30)),
        stage="1",
        energy_cost=1,
        energy_return=2,
        user_id=user_id,
    )
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    assert habit.id is not None
    return habit.id


async def _make_goal(session: AsyncSession, habit_id: int, *, is_additive: bool = True) -> int:
    """Seed a Goal row for the given habit and return its id."""
    goal = Goal(
        habit_id=habit_id,
        title="Daily sit",
        tier="clear",
        target=1.0,
        target_unit="minutes",
        frequency=1.0,
        frequency_unit="per_day",
        is_additive=is_additive,
    )
    session.add(goal)
    await session.commit()
    await session.refresh(goal)
    assert goal.id is not None
    return goal.id


async def _add_completions(
    session: AsyncSession,
    goal_id: int,
    user_id: int,
    *,
    days: int,
    completed_units: float,
) -> None:
    """Add one GoalCompletion row per day for the last ``days`` days."""
    now = datetime.now(UTC)
    for days_ago in range(days):
        session.add(
            GoalCompletion(
                goal_id=goal_id,
                user_id=user_id,
                completed_units=completed_units,
                timestamp=now - timedelta(days=days_ago),
            )
        )
    await session.commit()


# ---------------------------------------------------------------------------
# Unmet path: completions logged but at zero units, across the full window
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_habit_unmet_across_window_is_flagged(db_session: AsyncSession) -> None:
    """A habit with zero-unit completions across the window is flagged unmet."""
    user_id = await _make_user(db_session)
    habit_id = await _make_habit(db_session, user_id)
    goal_id = await _make_goal(db_session, habit_id)
    await _add_completions(
        db_session, goal_id, user_id, days=FOUNDATION_UNMET_CONSECUTIVE_DAYS, completed_units=0.0
    )

    aggregates = await gather_contraction_aggregates(db_session, user_id)

    matching = [h for h in aggregates.habits if h.habit_id == habit_id]
    assert matching
    assert (
        matching[0].consecutive_unmet_days >= FOUNDATION_UNMET_CONSECUTIVE_DAYS
        or matching[0].consecutive_unchecked_days >= FOUNDATION_UNCHECKED_CONSECUTIVE_DAYS
    )


# ---------------------------------------------------------------------------
# Healthy habit: recent positive completions -> not flagged
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_healthy_habit_is_not_flagged(db_session: AsyncSession) -> None:
    """A habit with recent positive completions has counts below the window."""
    user_id = await _make_user(db_session)
    habit_id = await _make_habit(db_session, user_id)
    goal_id = await _make_goal(db_session, habit_id)
    await _add_completions(db_session, goal_id, user_id, days=5, completed_units=1.0)

    aggregates = await gather_contraction_aggregates(db_session, user_id)

    matching = [h for h in aggregates.habits if h.habit_id == habit_id]
    assert matching
    assert matching[0].consecutive_unmet_days < FOUNDATION_UNMET_CONSECUTIVE_DAYS
    assert matching[0].consecutive_unchecked_days < FOUNDATION_UNCHECKED_CONSECUTIVE_DAYS


# ---------------------------------------------------------------------------
# Brand-new habit: too new to report as unchecked
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_brand_new_habit_is_not_reported_unchecked(db_session: AsyncSession) -> None:
    """A habit started within the window is excluded from the unchecked signal."""
    user_id = await _make_user(db_session)
    habit_id = await _make_habit(
        db_session,
        user_id,
        start_date=datetime.now(UTC).date() - timedelta(days=2),
    )
    await _make_goal(db_session, habit_id)

    aggregates = await gather_contraction_aggregates(db_session, user_id)

    matching = [h for h in aggregates.habits if h.habit_id == habit_id]
    assert matching
    assert matching[0].consecutive_unchecked_days < FOUNDATION_UNCHECKED_CONSECUTIVE_DAYS


# ---------------------------------------------------------------------------
# Subtractive goal: absence is success, must be excluded
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_subtractive_goal_is_excluded(db_session: AsyncSession) -> None:
    """A subtractive goal with no completions is never reported as unmet/unchecked."""
    user_id = await _make_user(db_session)
    habit_id = await _make_habit(db_session, user_id)
    await _make_goal(db_session, habit_id, is_additive=False)

    aggregates = await gather_contraction_aggregates(db_session, user_id)

    matching = [h for h in aggregates.habits if h.habit_id == habit_id]
    assert not matching, "a subtractive goal's silence must not be treated as a contraction signal"


# ---------------------------------------------------------------------------
# Read-only: no session mutation, no row changes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_gather_is_read_only(db_session: AsyncSession) -> None:
    """gather_contraction_aggregates must not add/modify any rows."""
    user_id = await _make_user(db_session)
    habit_id = await _make_habit(db_session, user_id)
    goal_id = await _make_goal(db_session, habit_id)
    await _add_completions(
        db_session, goal_id, user_id, days=FOUNDATION_UNMET_CONSECUTIVE_DAYS, completed_units=0.0
    )

    count_before = (
        await db_session.execute(select(func.count()).select_from(GoalCompletion))
    ).scalar_one()

    await gather_contraction_aggregates(db_session, user_id)

    assert not db_session.new
    assert not db_session.dirty

    count_after = (
        await db_session.execute(select(func.count()).select_from(GoalCompletion))
    ).scalar_one()
    assert count_after == count_before
