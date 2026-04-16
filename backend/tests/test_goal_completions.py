"""Tests for the goal completions API — DB-backed with authentication."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit


async def _signup(client: AsyncClient, username: str = "goaluser") -> tuple[dict[str, str], int]:
    """Create a user and return (auth headers, user_id)."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, data["user_id"]


async def _seed_goal(
    db_session: AsyncSession,
    user_id: int,
    *,
    habit_name: str = "Meditation",
) -> Goal:
    """Create a habit + goal in the DB and return the goal."""
    habit = Habit(
        name=habit_name,
        icon="🧘",
        start_date=date(2025, 1, 1),
        energy_cost=10,
        energy_return=20,
        user_id=user_id,
    )
    db_session.add(habit)
    await db_session.commit()
    await db_session.refresh(habit)

    goal = Goal(
        habit_id=habit.id,
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


# ── Unauthenticated access ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_completion_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": 1, "did_complete": True},
    )
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ── Completion increments streak ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_completion_increments_streak_and_returns_milestone(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client)
    goal = await _seed_goal(db_session, user_id)

    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["streak"] == 1
    assert data["reason_code"] == "streak_incremented"
    assert data["milestones"] == [{"threshold": 1}]


@pytest.mark.asyncio
async def test_same_day_completion_is_idempotent(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Second completion on the same day returns already_logged_today (BUG-HABITS-015)."""
    headers, user_id = await _signup(async_client)
    goal = await _seed_goal(db_session, user_id)

    # First completion
    resp1 = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )
    assert resp1.json()["streak"] == 1

    # Same-day retry
    resp2 = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )
    assert resp2.status_code == HTTPStatus.OK
    data = resp2.json()
    assert data["streak"] == 1
    assert data["reason_code"] == "already_logged_today"
    assert data["milestones"] == []


@pytest.mark.asyncio
async def test_consecutive_day_completions_build_streak(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Completions on consecutive days build the streak."""
    headers, user_id = await _signup(async_client)
    goal = await _seed_goal(db_session, user_id)

    # Seed a completion for yesterday directly in the DB
    db_session.add(
        GoalCompletion(
            goal_id=goal.id,
            user_id=user_id,
            completed_units=goal.target,
            timestamp=datetime.now(UTC) - timedelta(days=1),
        )
    )
    await db_session.commit()

    # Today's completion via API
    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    expected_streak = 2
    assert data["streak"] == expected_streak


# ── Miss resets streak ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_miss_resets_streak(async_client: AsyncClient, db_session: AsyncSession) -> None:
    headers, user_id = await _signup(async_client)
    goal = await _seed_goal(db_session, user_id)

    # Seed a completion yesterday
    db_session.add(
        GoalCompletion(
            goal_id=goal.id,
            user_id=user_id,
            completed_units=goal.target,
            timestamp=datetime.now(UTC) - timedelta(days=1),
        )
    )
    await db_session.commit()

    # Log a miss today
    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": False},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["streak"] == 0
    assert data["reason_code"] == "streak_reset"
    assert data["milestones"] == []


# ── Unknown goal returns 404 ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unknown_goal_returns_404(async_client: AsyncClient) -> None:
    headers, _user_id = await _signup(async_client)
    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": 999, "did_complete": True},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


# ── User isolation ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_other_users_goal_returns_403(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    _alice_headers, alice_id = await _signup(async_client, "alice")
    bob_headers, _bob_id = await _signup(async_client, "bob")

    goal = await _seed_goal(db_session, alice_id)

    # Bob tries to complete Alice's goal
    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=bob_headers,
    )
    assert resp.status_code == HTTPStatus.FORBIDDEN


# ── Completion is persisted ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_completion_is_persisted_in_db(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client)
    goal = await _seed_goal(db_session, user_id)

    await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )

    result = await db_session.execute(
        select(GoalCompletion).where(GoalCompletion.goal_id == goal.id)
    )
    completions = list(result.scalars().all())
    assert len(completions) == 1
    assert completions[0].user_id == user_id
