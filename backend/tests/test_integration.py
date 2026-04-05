"""Multi-step integration tests that exercise real user flows end-to-end.

Each test chains multiple API calls to verify that features compose correctly
across routers, models, and domain logic -- catching integration bugs that
narrow unit tests miss.
"""

from __future__ import annotations

from datetime import UTC, datetime
from http import HTTPStatus
from typing import Any

import jwt
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.goal import Goal
from models.practice import Practice

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_EXPECTED_STREAK_AFTER_TWO = 2
_STREAK_COMPLETIONS = 3
_PRACTICE_SESSION_COUNT = 3

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _signup(
    client: AsyncClient,
    email: str = "alice@test.com",
    password: str = "securepassword123",
) -> dict[str, Any]:
    """Register a new user and return the auth response."""
    resp = await client.post("/auth/signup", json={"email": email, "password": password})
    assert resp.status_code == HTTPStatus.OK
    result: dict[str, Any] = resp.json()
    return result


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _create_habit(
    client: AsyncClient,
    token: str,
    **overrides: object,
) -> dict[str, Any]:
    """Create a habit via the API and return the response body."""
    payload: dict[str, object] = {
        "name": "Meditation",
        "icon": "🧘",
        "start_date": "2025-01-01",
        "energy_cost": 2,
        "energy_return": 5,
        **overrides,
    }
    resp = await client.post("/habits/", json=payload, headers=_auth_headers(token))
    assert resp.status_code == HTTPStatus.OK
    result: dict[str, Any] = resp.json()
    return result


async def _seed_goal(
    db_session: AsyncSession,
    habit_id: int,
    *,
    title: str = "Daily meditation",
    tier: str = "low",
    target: float = 1.0,
) -> Goal:
    """Insert a goal directly into the test database."""
    goal = Goal(
        habit_id=habit_id,
        title=title,
        tier=tier,
        target=target,
        target_unit="sessions",
        frequency=1.0,
        frequency_unit="per_day",
        is_additive=True,
    )
    db_session.add(goal)
    await db_session.commit()
    await db_session.refresh(goal)
    return goal


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
class TestSignupHabitGoalFlow:
    """Signup -> Create habit -> Seed goal -> Log completion -> Verify streak."""

    async def test_full_flow(self, async_client: AsyncClient, db_session: AsyncSession) -> None:
        # 1. Sign up
        auth = await _signup(async_client)
        token = str(auth["token"])

        # 2. Create a habit
        habit_data = await _create_habit(async_client, token)
        habit_id = int(habit_data["id"])

        # 3. Seed a goal for the habit
        goal = await _seed_goal(db_session, habit_id)
        assert goal.id is not None

        # 4. Complete the goal twice to build a streak
        data: dict[str, Any] = {}
        for _ in range(_EXPECTED_STREAK_AFTER_TWO):
            resp = await async_client.post(
                "/goal_completions/",
                json={"goal_id": goal.id, "did_complete": True},
                headers=_auth_headers(token),
            )
            assert resp.status_code == HTTPStatus.OK
            data = resp.json()
            assert data["streak"] >= 1

        # 5. The second completion should yield a streak of 2
        assert data["streak"] == _EXPECTED_STREAK_AFTER_TWO

        # 6. Milestone threshold=1 should be reached
        thresholds = [m["threshold"] for m in data["milestones"]]
        assert 1 in thresholds

    async def test_missed_completion_resets_streak(
        self, async_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        auth = await _signup(async_client, email="bob@test.com")
        token = str(auth["token"])
        habit_data = await _create_habit(async_client, token)
        goal = await _seed_goal(db_session, int(habit_data["id"]))
        assert goal.id is not None

        # Build a streak of 3
        for _ in range(_STREAK_COMPLETIONS):
            await async_client.post(
                "/goal_completions/",
                json={"goal_id": goal.id, "did_complete": True},
                headers=_auth_headers(token),
            )

        # Miss a day
        resp = await async_client.post(
            "/goal_completions/",
            json={"goal_id": goal.id, "did_complete": False},
            headers=_auth_headers(token),
        )
        assert resp.status_code == HTTPStatus.OK
        assert resp.json()["streak"] == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
class TestHabitReorderPersistence:
    """Create multiple habits -> Reorder -> Verify sort order persisted."""

    async def test_reorder_persists(self, async_client: AsyncClient) -> None:
        auth = await _signup(async_client, email="carol@test.com")
        token = str(auth["token"])
        headers = _auth_headers(token)

        # Create 3 habits
        names = ["Alpha", "Beta", "Gamma"]
        habit_ids: list[int] = []
        for name in names:
            data = await _create_habit(async_client, token, name=name, icon="📌")
            habit_ids.append(int(data["id"]))

        # Update sort_order in reverse
        for i, hid in enumerate(reversed(habit_ids)):
            resp = await async_client.put(
                f"/habits/{hid}",
                json={
                    "name": names[habit_ids.index(hid)],
                    "icon": "📌",
                    "start_date": "2025-01-01",
                    "energy_cost": 2,
                    "energy_return": 5,
                    "sort_order": i,
                },
                headers=headers,
            )
            assert resp.status_code == HTTPStatus.OK

        # List habits and verify the new order
        resp = await async_client.get("/habits/", headers=headers)
        assert resp.status_code == HTTPStatus.OK
        listed = resp.json()
        listed_names = [h["name"] for h in listed]
        assert listed_names == ["Gamma", "Beta", "Alpha"]


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
class TestPracticeSessionWeekCount:
    """Create practice -> Select it -> Log sessions -> Check week count."""

    async def test_session_count(self, async_client: AsyncClient, db_session: AsyncSession) -> None:
        auth = await _signup(async_client, email="dave@test.com")
        token = str(auth["token"])
        headers = _auth_headers(token)

        # Seed an approved practice in the DB
        practice = Practice(
            stage_number=1,
            name="Mindfulness",
            description="Focus on breath",
            instructions="Sit quietly and breathe",
            default_duration_minutes=10,
            approved=True,
        )
        db_session.add(practice)
        await db_session.commit()
        await db_session.refresh(practice)
        assert practice.id is not None

        # Select the practice via API
        resp = await async_client.post(
            "/user-practices/",
            json={"practice_id": practice.id, "stage_number": 1},
            headers=headers,
        )
        assert resp.status_code == HTTPStatus.CREATED
        up_id = resp.json()["id"]

        # Log sessions
        for _ in range(_PRACTICE_SESSION_COUNT):
            resp = await async_client.post(
                "/practice-sessions/",
                json={
                    "user_practice_id": up_id,
                    "duration_minutes": 10.0,
                    "reflection": "Felt calm",
                },
                headers=headers,
            )
            assert resp.status_code == HTTPStatus.OK

        # Verify week count
        resp = await async_client.get("/practice-sessions/week-count", headers=headers)
        assert resp.status_code == HTTPStatus.OK
        assert resp.json()["count"] == _PRACTICE_SESSION_COUNT


@pytest.mark.asyncio
class TestExpiredTokenReturns401:
    """An expired JWT should be rejected with 401 on all protected endpoints."""

    async def test_expired_token_habits(self, async_client: AsyncClient) -> None:
        expired_token = jwt.encode(
            {
                "sub": "999",
                "exp": datetime(2020, 1, 1, tzinfo=UTC),
                "iat": datetime(2020, 1, 1, tzinfo=UTC),
            },
            "test-secret-key-for-unit-tests-only",
            algorithm="HS256",
        )
        headers = _auth_headers(expired_token)

        endpoints = [
            ("GET", "/habits/"),
            ("GET", "/practice-sessions/week-count"),
            ("GET", "/user-practices/"),
        ]
        for method, url in endpoints:
            resp = await async_client.request(method, url, headers=headers)
            assert resp.status_code == HTTPStatus.UNAUTHORIZED, f"{method} {url} did not return 401"
            assert resp.json()["detail"] == "expired_token"


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
class TestCrossUserIsolation:
    """One user cannot access another user's habits."""

    async def test_user_cannot_see_other_habits(self, async_client: AsyncClient) -> None:
        # User A creates a habit
        auth_a = await _signup(async_client, email="user_a@test.com")
        token_a = str(auth_a["token"])
        habit = await _create_habit(async_client, token_a, name="Secret Habit")
        habit_id = int(habit["id"])

        # User B tries to access it
        auth_b = await _signup(async_client, email="user_b@test.com")
        token_b = str(auth_b["token"])

        resp = await async_client.get(f"/habits/{habit_id}", headers=_auth_headers(token_b))
        assert resp.status_code == HTTPStatus.NOT_FOUND

        # User B's habit list should be empty
        resp = await async_client.get("/habits/", headers=_auth_headers(token_b))
        assert resp.status_code == HTTPStatus.OK
        assert resp.json() == []
