"""Unit tests for :mod:`services.streaks` — DB-aware streak + milestone helpers."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.user import User
from schemas.milestone import Milestone
from services.streaks import check_milestones, compute_consecutive_streak, update_streak


async def _make_goal(session: AsyncSession, user_id: int) -> Goal:
    """Create a habit + goal owned by ``user_id`` and return the persisted goal."""
    habit = Habit(
        name="Meditate",
        icon="meditate",
        start_date=date.today(),
        stage="1",
        streak=0,
        energy_cost=1,
        energy_return=2,
        user_id=user_id,
    )
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    assert habit.id is not None

    goal = Goal(
        habit_id=habit.id,
        title="Sit ten minutes",
        tier="clear",
        target=1.0,
        target_unit="minutes",
        frequency=1.0,
        frequency_unit="per_day",
    )
    session.add(goal)
    await session.commit()
    await session.refresh(goal)
    return goal


async def _make_user(session: AsyncSession) -> User:
    user = User(email="streaks@example.com")
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user


def test_check_milestones_returns_only_newly_crossed() -> None:
    """Only thresholds where old < t <= new are returned (BUG-HABITS-008)."""
    assert check_milestones(7, [1, 3, 7, 14], old_streak=6) == [
        Milestone(threshold=7),
    ]


def test_check_milestones_all_new_when_old_is_zero() -> None:
    """With old_streak=0, all reached thresholds are returned."""
    assert check_milestones(7, [1, 3, 7, 14]) == [
        Milestone(threshold=1),
        Milestone(threshold=3),
        Milestone(threshold=7),
    ]


def test_check_milestones_returns_empty_when_none_reached() -> None:
    assert check_milestones(0, [1, 3, 7]) == []


def test_update_streak_is_re_exported_from_service() -> None:
    """``update_streak`` should stay importable from the service layer too."""
    assert update_streak(2, did_check_in=True) == (3, "streak_incremented")
    assert update_streak(99, did_check_in=False) == (0, "streak_reset")


@pytest.mark.asyncio
async def test_compute_consecutive_streak_counts_unique_days(
    db_session: AsyncSession,
) -> None:
    """Completions on consecutive days contribute to the streak (BUG-HABITS-011)."""
    user = await _make_user(db_session)
    assert user.id is not None
    goal = await _make_goal(db_session, user.id)
    assert goal.id is not None

    now = datetime.now(UTC)
    for days_ago in range(3):
        db_session.add(
            GoalCompletion(
                goal_id=goal.id,
                user_id=user.id,
                completed_units=goal.target,
                timestamp=now - timedelta(days=days_ago),
            )
        )
    await db_session.commit()

    assert await compute_consecutive_streak(db_session, goal.id, user.id) == 3  # noqa: PLR2004


@pytest.mark.asyncio
async def test_compute_consecutive_streak_collapses_same_day_rows(
    db_session: AsyncSession,
) -> None:
    """Multiple completions on the same day count as one streak day."""
    user = await _make_user(db_session)
    assert user.id is not None
    goal = await _make_goal(db_session, user.id)
    assert goal.id is not None

    for _ in range(3):
        db_session.add(
            GoalCompletion(goal_id=goal.id, user_id=user.id, completed_units=goal.target)
        )
    await db_session.commit()

    assert await compute_consecutive_streak(db_session, goal.id, user.id) == 1


@pytest.mark.asyncio
async def test_compute_consecutive_streak_resets_on_most_recent_miss(
    db_session: AsyncSession,
) -> None:
    """A miss day after completions zeros the reported streak."""
    user = await _make_user(db_session)
    assert user.id is not None
    goal = await _make_goal(db_session, user.id)
    assert goal.id is not None

    now = datetime.now(UTC)
    db_session.add(
        GoalCompletion(
            goal_id=goal.id,
            user_id=user.id,
            completed_units=goal.target,
            timestamp=now - timedelta(days=1),
        )
    )
    await db_session.commit()
    db_session.add(
        GoalCompletion(goal_id=goal.id, user_id=user.id, completed_units=0, timestamp=now)
    )
    await db_session.commit()

    assert await compute_consecutive_streak(db_session, goal.id, user.id) == 0


@pytest.mark.asyncio
async def test_compute_consecutive_streak_returns_zero_for_new_goal(
    db_session: AsyncSession,
) -> None:
    user = await _make_user(db_session)
    assert user.id is not None
    goal = await _make_goal(db_session, user.id)
    assert goal.id is not None

    assert await compute_consecutive_streak(db_session, goal.id, user.id) == 0
