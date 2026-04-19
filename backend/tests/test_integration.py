"""Multi-step integration tests exercising end-to-end API flows.

These tests verify that different API endpoints work together correctly
in realistic user scenarios — signup, habit creation, goal completion,
practice sessions, and token expiry across all protected endpoints.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import jwt
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.practice import Practice

SIGNUP_URL = "/auth/signup"
LOGIN_URL = "/auth/login"
SECRET_KEY = "test-secret-key-for-unit-tests-only"  # pragma: allowlist secret

HABIT_PAYLOAD = {
    "name": "Meditation",
    "icon": "🧘",
    "start_date": "2025-01-01",
    "energy_cost": 2,
    "energy_return": 5,
    "stage": "Beige",
}


async def _auth_headers(client: AsyncClient, email: str = "user@example.com") -> dict[str, str]:
    """Sign up a user and return Authorization headers."""
    resp = await client.post(
        SIGNUP_URL,
        json={"email": email, "password": "securepassword123"},  # pragma: allowlist secret
    )
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


async def _create_habit(
    client: AsyncClient,
    headers: dict[str, str],
    **overrides: object,
) -> dict[str, object]:
    """Create a habit and return the response body."""
    payload = {**HABIT_PAYLOAD, **overrides}
    resp = await client.post("/habits/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    result: dict[str, object] = resp.json()
    return result


# ── Flow 1: Signup → Create habit → Add goal → Log completion → Check streak ──


@pytest.mark.asyncio
async def test_signup_create_habit_log_completion_check_streak(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Full user flow from signup through streak verification.

    Signs up, creates a habit, adds a goal, logs completions, and
    verifies streak increments with milestone detection.
    """
    headers = await _auth_headers(async_client)

    # Create a habit
    habit = await _create_habit(async_client, headers)
    habit_id = habit["id"]

    # Add a goal directly via the database (goals are created by the frontend
    # and associated with habits; the API doesn't have a dedicated goal endpoint)
    goal = Goal(
        habit_id=int(str(habit_id)),
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

    # Seed completions on 2 prior days to build a streak history
    now = datetime.now(UTC)
    for days_ago in [2, 1]:
        db_session.add(
            GoalCompletion(
                goal_id=goal.id,
                user_id=int(str(habit["user_id"])),
                completed_units=goal.target,
                timestamp=now - timedelta(days=days_ago),
            )
        )
    await db_session.commit()

    # Today's completion via API — streak should be 3 (2 seeded + 1 today)
    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["streak"] == 3
    assert data["reason_code"] == "streak_incremented"
    # Crosses thresholds 1, 3 (old_streak=2 -> new_streak=3)
    assert any(m["threshold"] == 3 for m in data["milestones"])

    # Same-day retry is idempotent
    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["reason_code"] == "already_logged_today"


# ── Flow 2: Create multiple habits → Verify sort order ───────────────────


@pytest.mark.asyncio
async def test_create_multiple_habits_sort_order(async_client: AsyncClient) -> None:
    """Create habits with explicit sort_order and verify list returns them sorted."""
    headers = await _auth_headers(async_client)

    await _create_habit(async_client, headers, name="Third", sort_order=3)
    await _create_habit(async_client, headers, name="First", sort_order=1)
    await _create_habit(async_client, headers, name="Second", sort_order=2)

    resp = await async_client.get("/habits/", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    habits = resp.json()
    names = [h["name"] for h in habits]
    assert names == ["First", "Second", "Third"]


# ── Flow 3: Practice session → Week count ────────────────────────────────


@pytest.mark.asyncio
async def test_practice_session_week_count(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Create a practice, select it, log sessions, and verify week count."""
    headers = await _auth_headers(async_client)

    # Seed an approved practice
    practice = Practice(
        stage_number=1,
        name="Breath awareness",
        description="Focus on breath",
        instructions="Sit and breathe",
        default_duration_minutes=10,
        approved=True,
    )
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)

    # Select the practice
    resp = await async_client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": 1},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    user_practice_id = resp.json()["id"]

    # Log two practice sessions
    for duration in (10.0, 15.0):
        resp = await async_client.post(
            "/practice-sessions/",
            json={
                "user_practice_id": user_practice_id,
                "duration_minutes": duration,
                "reflection": "Felt calm",
            },
            headers=headers,
        )
        assert resp.status_code == HTTPStatus.OK

    # Check week count
    resp = await async_client.get("/practice-sessions/week-count", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["count"] == 2


# ── Flow 4: Expired token → All endpoints return 401 ─────────────────────


@pytest.mark.asyncio
async def test_expired_token_rejected_across_endpoints(async_client: AsyncClient) -> None:
    """An expired JWT should return 401 on every protected endpoint."""
    # Sign up to get a valid user_id
    signup_resp = await async_client.post(
        SIGNUP_URL,
        json={
            "email": "expired@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    user_id = signup_resp.json()["user_id"]

    expired_token = jwt.encode(
        {"sub": str(user_id), "exp": 0, "iat": 0},
        SECRET_KEY,
        algorithm="HS256",
    )
    headers = {"Authorization": f"Bearer {expired_token}"}

    get_endpoints = [
        "/habits/",
        "/practice-sessions/week-count",
        "/user-practices/",
        "/journal/",
        "/stages",
    ]

    for url in get_endpoints:
        resp = await async_client.get(url, headers=headers)
        assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ── Flow 5: User isolation — users cannot see each other's habits ─────────


@pytest.mark.asyncio
async def test_user_isolation_habits(async_client: AsyncClient) -> None:
    """Habits created by one user are invisible to another."""
    headers_a = await _auth_headers(async_client, email="alice@example.com")
    headers_b = await _auth_headers(async_client, email="bob@example.com")

    # Alice creates a habit
    await _create_habit(async_client, headers_a, name="Alice's habit")

    # Bob lists habits — should see none
    resp = await async_client.get("/habits/", headers=headers_b)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == []

    # Bob tries to access Alice's habit by ID — should get 404
    alice_habits = await async_client.get("/habits/", headers=headers_a)
    alice_habit_id = alice_habits.json()[0]["id"]

    resp = await async_client.get(f"/habits/{alice_habit_id}", headers=headers_b)
    assert resp.status_code == HTTPStatus.NOT_FOUND
