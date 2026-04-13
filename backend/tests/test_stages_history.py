"""Tests for GET /stages/{stage_number}/history endpoint."""

from __future__ import annotations

from datetime import UTC, date, datetime
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.course_stage import CourseStage
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.practice import Practice
from models.practice_session import PracticeSession
from models.user_practice import UserPractice


def _stage_data(stage_number: int = 1) -> dict[str, object]:
    """Valid CourseStage fields for DB insertion."""
    return {
        "title": f"Stage {stage_number}",
        "subtitle": f"Subtitle {stage_number}",
        "stage_number": stage_number,
        "overview_url": f"https://example.com/stage-{stage_number}",
        "category": "test",
        "aspect": "test-aspect",
        "spiral_dynamics_color": "beige",
        "growing_up_stage": "archaic",
        "divine_gender_polarity": "masculine",
        "relationship_to_free_will": "active",
        "free_will_description": "Test description",
    }


async def _signup(
    client: AsyncClient,
    username: str = "histuser",
) -> tuple[dict[str, str], int]:
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


async def _seed_stage(db_session: AsyncSession, stage_number: int = 1) -> CourseStage:
    """Insert a single test stage."""
    stage = CourseStage(**_stage_data(stage_number))
    db_session.add(stage)
    await db_session.commit()
    await db_session.refresh(stage)
    return stage


# ── Authentication ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_history_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/stages/1/history")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ── Not found ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_history_stage_not_found(async_client: AsyncClient) -> None:
    headers, _uid = await _signup(async_client)
    resp = await async_client.get("/stages/99/history", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


# ── Empty history ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_history_empty_for_stage_with_no_activity(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Stage with no practices or habits returns empty lists."""
    headers, _uid = await _signup(async_client)
    await _seed_stage(db_session, stage_number=1)

    resp = await async_client.get("/stages/1/history", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["stage_number"] == 1
    assert data["practices"] == []
    assert data["habits"] == []


# ── Practice history aggregation ───────────────────────────────────────


@pytest.mark.asyncio
async def test_history_returns_practice_aggregation(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Practices show session count, total minutes, and last session."""
    headers, user_id = await _signup(async_client)
    await _seed_stage(db_session, stage_number=1)

    practice = Practice(
        stage_number=1,
        name="Breath of Fire",
        description="Rapid breath",
        instructions="Inhale-exhale quickly",
        default_duration_minutes=15,
    )
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)

    user_practice = UserPractice(
        user_id=user_id,
        practice_id=practice.id,
        stage_number=1,
        start_date=date(2026, 1, 1),
    )
    db_session.add(user_practice)
    await db_session.commit()
    await db_session.refresh(user_practice)

    session_count = 3
    duration = 15.0
    for i in range(session_count):
        ps = PracticeSession(
            user_id=user_id,
            user_practice_id=user_practice.id,
            duration_minutes=duration,
            timestamp=datetime(2026, 3, 10 + i, 10, 0, tzinfo=UTC),
        )
        db_session.add(ps)
    await db_session.commit()

    resp = await async_client.get("/stages/1/history", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()

    assert len(data["practices"]) == 1
    p = data["practices"][0]
    assert p["name"] == "Breath of Fire"
    assert p["sessions_completed"] == session_count
    assert p["total_minutes"] == duration * session_count
    assert p["last_session"] is not None


# ── Habit history aggregation ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_history_returns_habit_aggregation(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Habits show goals_achieved tiers, best_streak, and total completions."""
    headers, user_id = await _signup(async_client)
    await _seed_stage(db_session, stage_number=1)

    best_streak = 14
    habit = Habit(
        name="Morning Exercise",
        icon="🏃",
        start_date=date(2026, 1, 1),
        energy_cost=2,
        energy_return=3,
        user_id=user_id,
        stage="1",
        streak=best_streak,
    )
    db_session.add(habit)
    await db_session.commit()
    await db_session.refresh(habit)

    # Create goals at three tiers
    low_goal = Goal(
        habit_id=habit.id,
        title="Low",
        tier="low",
        target=10,
        target_unit="reps",
        frequency=1,
        frequency_unit="per_day",
    )
    clear_goal = Goal(
        habit_id=habit.id,
        title="Clear",
        tier="clear",
        target=20,
        target_unit="reps",
        frequency=1,
        frequency_unit="per_day",
    )
    stretch_goal = Goal(
        habit_id=habit.id,
        title="Stretch",
        tier="stretch",
        target=30,
        target_unit="reps",
        frequency=1,
        frequency_unit="per_day",
    )
    db_session.add_all([low_goal, clear_goal, stretch_goal])
    await db_session.commit()
    for g in [low_goal, clear_goal, stretch_goal]:
        await db_session.refresh(g)

    # Add completions for low and clear, but not stretch
    completion_count = 5
    for goal in [low_goal, clear_goal]:
        for _ in range(completion_count):
            gc = GoalCompletion(
                goal_id=goal.id,
                user_id=user_id,
                completed_units=10,
            )
            db_session.add(gc)
    await db_session.commit()

    resp = await async_client.get("/stages/1/history", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()

    assert len(data["habits"]) == 1
    h = data["habits"][0]
    assert h["name"] == "Morning Exercise"
    assert h["icon"] == "🏃"
    assert h["best_streak"] == best_streak
    assert h["total_completions"] == completion_count * 2  # low + clear
    assert h["goals_achieved"]["low"] is True
    assert h["goals_achieved"]["clear"] is True
    assert h["goals_achieved"]["stretch"] is False


# ── User isolation ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_history_only_returns_requesting_users_data(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """User A's history should not include user B's practices or habits."""
    alice_headers, alice_id = await _signup(async_client, "alice_hist")
    bob_headers, _bob_id = await _signup(async_client, "bob_hist")
    await _seed_stage(db_session, stage_number=1)

    # Create practice data for Alice only
    practice = Practice(
        stage_number=1,
        name="Meditation",
        description="Sit",
        instructions="Breathe",
        default_duration_minutes=10,
    )
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)

    alice_up = UserPractice(
        user_id=alice_id,
        practice_id=practice.id,
        stage_number=1,
        start_date=date(2026, 1, 1),
    )
    db_session.add(alice_up)
    await db_session.commit()
    await db_session.refresh(alice_up)

    ps = PracticeSession(
        user_id=alice_id,
        user_practice_id=alice_up.id,
        duration_minutes=10.0,
    )
    db_session.add(ps)
    await db_session.commit()

    # Create a habit for Alice only
    habit = Habit(
        name="Alice Habit",
        icon="🌸",
        start_date=date(2026, 1, 1),
        energy_cost=1,
        energy_return=1,
        user_id=alice_id,
        stage="1",
        streak=5,
    )
    db_session.add(habit)
    await db_session.commit()

    # Bob should see empty history
    resp = await async_client.get("/stages/1/history", headers=bob_headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["practices"] == []
    assert data["habits"] == []

    # Alice should see her data
    resp = await async_client.get("/stages/1/history", headers=alice_headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert len(data["practices"]) == 1
    assert len(data["habits"]) == 1
