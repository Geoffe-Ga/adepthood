"""Direct contract tests for dependencies.ownership.resolve_owned_goal_and_habit."""

from __future__ import annotations

from datetime import date
from http import HTTPStatus

import pytest
from fastapi import HTTPException
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from dependencies.ownership import resolve_owned_goal_and_habit
from models.goal import Goal
from models.habit import Habit
from models.user import User

# Habit id that never exists; simulates an orphaned FK without ORM cascade-delete.
_NONEXISTENT_HABIT_ID = 999_999


async def _seed_user(db_session: AsyncSession, email: str) -> int:
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    assert user.id is not None
    return user.id


async def _seed_habit(db_session: AsyncSession, user_id: int) -> Habit:
    habit = Habit(
        name="Meditation",
        icon="x",
        start_date=date(2025, 1, 1),
        energy_cost=10,
        energy_return=20,
        user_id=user_id,
    )
    db_session.add(habit)
    await db_session.commit()
    await db_session.refresh(habit)
    return habit


async def _seed_goal(db_session: AsyncSession, habit_id: int) -> Goal:
    goal = Goal(
        habit_id=habit_id,
        title="Daily sit",
        tier="clear",
        target=10.0,
        target_unit="minutes",
        frequency=1.0,
        frequency_unit="per_day",
        is_additive=True,
    )
    db_session.add(goal)
    await db_session.commit()
    await db_session.refresh(goal)
    return goal


@pytest.mark.asyncio
async def test_resolve_owned_goal_and_habit_returns_both_for_owned_goal(
    db_session: AsyncSession,
) -> None:
    user_id = await _seed_user(db_session, "owner@example.com")
    habit = await _seed_habit(db_session, user_id)
    assert habit.id is not None
    goal = await _seed_goal(db_session, habit.id)
    assert goal.id is not None

    resolved_goal, resolved_habit = await resolve_owned_goal_and_habit(db_session, goal.id, user_id)

    assert resolved_goal.id == goal.id
    assert resolved_habit.id == habit.id


@pytest.mark.asyncio
async def test_resolve_owned_goal_and_habit_missing_goal_raises_404(
    db_session: AsyncSession,
) -> None:
    user_id = await _seed_user(db_session, "solo@example.com")

    with pytest.raises(HTTPException) as exc_info:
        await resolve_owned_goal_and_habit(db_session, 999, user_id)

    assert exc_info.value.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_resolve_owned_goal_and_habit_orphaned_fk_raises_404(
    db_session: AsyncSession,
) -> None:
    user_id = await _seed_user(db_session, "orphan@example.com")
    habit = await _seed_habit(db_session, user_id)
    assert habit.id is not None
    goal = await _seed_goal(db_session, habit.id)
    assert goal.id is not None
    # SQLite in tests does not enforce FKs, so this repoints habit_id directly.
    await db_session.execute(
        update(Goal).where(col(Goal.id) == goal.id).values(habit_id=_NONEXISTENT_HABIT_ID)
    )
    await db_session.commit()

    with pytest.raises(HTTPException) as exc_info:
        await resolve_owned_goal_and_habit(db_session, goal.id, user_id)

    assert exc_info.value.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_resolve_owned_goal_and_habit_cross_tenant_raises_404(
    db_session: AsyncSession,
) -> None:
    owner_id = await _seed_user(db_session, "alice_owner@example.com")
    other_id = await _seed_user(db_session, "bob_other@example.com")
    habit = await _seed_habit(db_session, owner_id)
    assert habit.id is not None
    goal = await _seed_goal(db_session, habit.id)
    assert goal.id is not None

    with pytest.raises(HTTPException) as exc_info:
        await resolve_owned_goal_and_habit(db_session, goal.id, other_id)

    assert exc_info.value.status_code == HTTPStatus.NOT_FOUND
