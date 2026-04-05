"""Multi-step integration tests that exercise end-to-end user flows.

These tests verify that multiple API endpoints work together correctly,
simulating real user workflows like signup → habit creation → goal tracking.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.goal import Goal
from models.practice import Practice


async def _signup(client: AsyncClient, username: str = "integration") -> tuple[dict[str, str], int]:
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


def _habit_payload(**overrides: object) -> dict[str, object]:
    """Return a valid habit creation payload."""
    payload: dict[str, object] = {
        "name": "Meditation",
        "icon": "🧘",
        "start_date": "2025-01-01",
        "energy_cost": 10,
        "energy_return": 20,
        "stage": "aptitude",
    }
    payload.update(overrides)
    return payload


# ── Flow 1: Signup → Create habit → Log completion → Check progress ────


@pytest.mark.asyncio
async def test_signup_create_habit_log_completion_check_milestone(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Full user flow: signup, create a habit with a goal, log a completion,
    and verify the streak is updated with milestones triggered."""
    # Step 1: Signup
    headers, user_id = await _signup(async_client, "flow1")

    # Step 2: Create a habit via API
    habit_resp = await async_client.post("/habits/", json=_habit_payload(), headers=headers)
    assert habit_resp.status_code == HTTPStatus.OK
    habit_id = habit_resp.json()["id"]

    # Step 3: Seed a goal (via DB — goals don't have a creation endpoint in habits router)
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

    # Step 4: Log a goal completion
    completion_resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )
    assert completion_resp.status_code == HTTPStatus.OK
    completion_data = completion_resp.json()
    assert completion_data["streak"] == 1
    assert completion_data["reason_code"] == "streak_incremented"
    # First completion triggers the threshold-1 milestone
    assert {"threshold": 1} in completion_data["milestones"]

    # Step 5: Verify the habit still exists and has the goal attached
    habit_detail_resp = await async_client.get(f"/habits/{habit_id}", headers=headers)
    assert habit_detail_resp.status_code == HTTPStatus.OK
    assert len(habit_detail_resp.json()["goals"]) == 1


# ── Flow 2: Create multiple habits → Reorder → Verify sort persisted ──


@pytest.mark.asyncio
async def test_create_habits_reorder_verify_sort(async_client: AsyncClient) -> None:
    """Create two habits with explicit sort_order, then update one to change
    order, and verify the list reflects the new ordering."""
    headers, _user_id = await _signup(async_client, "flow2")

    # Create habits in reverse order
    await async_client.post(
        "/habits/", json=_habit_payload(name="Second", sort_order=2), headers=headers
    )
    await async_client.post(
        "/habits/", json=_habit_payload(name="First", sort_order=1), headers=headers
    )

    # Verify initial sort order
    list_resp = await async_client.get("/habits/", headers=headers)
    assert list_resp.status_code == HTTPStatus.OK
    names = [h["name"] for h in list_resp.json()]
    assert names == ["First", "Second"]

    # Reorder: make "Second" come first by updating sort_order
    second_id = next(h["id"] for h in list_resp.json() if h["name"] == "Second")
    first_id = next(h["id"] for h in list_resp.json() if h["name"] == "First")

    await async_client.put(
        f"/habits/{second_id}",
        json=_habit_payload(name="Second", sort_order=0),
        headers=headers,
    )
    await async_client.put(
        f"/habits/{first_id}",
        json=_habit_payload(name="First", sort_order=5),
        headers=headers,
    )

    # Verify new order
    reordered_resp = await async_client.get("/habits/", headers=headers)
    reordered_names = [h["name"] for h in reordered_resp.json()]
    assert reordered_names == ["Second", "First"]


# ── Flow 3: Practice session → Week count verification ─────────────────


@pytest.mark.asyncio
async def test_practice_session_increments_week_count(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Create a practice, select it, log a session, and verify the weekly
    session count increments correctly."""
    headers, user_id = await _signup(async_client, "flow3")

    # Seed a practice in the DB
    practice = Practice(
        stage_number=1,
        name="Breath Awareness",
        description="Focus on the breath",
        instructions="Sit comfortably and observe your breathing",
        default_duration_minutes=15,
        approved=True,
    )
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)

    # Select the practice via API
    select_resp = await async_client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": 1},
        headers=headers,
    )
    assert select_resp.status_code == HTTPStatus.CREATED
    user_practice_id = select_resp.json()["id"]

    # Verify initial week count is 0
    count_resp = await async_client.get("/practice-sessions/week-count", headers=headers)
    assert count_resp.status_code == HTTPStatus.OK
    assert count_resp.json()["count"] == 0

    # Log a practice session
    session_resp = await async_client.post(
        "/practice-sessions/",
        json={
            "user_practice_id": user_practice_id,
            "duration_minutes": 15.0,
            "reflection": "Felt calm and centered",
        },
        headers=headers,
    )
    assert session_resp.status_code == HTTPStatus.OK

    # Verify week count is now 1
    count_resp2 = await async_client.get("/practice-sessions/week-count", headers=headers)
    assert count_resp2.status_code == HTTPStatus.OK
    assert count_resp2.json()["count"] == 1


# ── Flow 4: Expired/invalid token → All endpoints return 401 ──────────


@pytest.mark.asyncio
async def test_expired_token_returns_401_across_endpoints(async_client: AsyncClient) -> None:
    """An expired or invalid token should produce 401 on all protected endpoints."""
    bad_headers = {"Authorization": "Bearer invalid.token.here"}

    endpoints = [
        ("GET", "/habits/"),
        ("POST", "/habits/"),
        ("GET", "/habits/1"),
        ("PUT", "/habits/1"),
        ("DELETE", "/habits/1"),
        ("POST", "/goal_completions/"),
        ("GET", "/practice-sessions/week-count"),
        ("POST", "/practice-sessions/"),
        ("GET", "/user-practices/"),
        ("POST", "/user-practices/"),
        ("GET", "/journal/"),
        ("POST", "/journal/"),
        ("GET", "/stages"),
    ]

    for method, path in endpoints:
        if method == "GET":
            resp = await async_client.get(path, headers=bad_headers)
        elif method == "POST":
            resp = await async_client.post(path, json={}, headers=bad_headers)
        elif method == "PUT":
            resp = await async_client.put(path, json={}, headers=bad_headers)
        elif method == "DELETE":
            resp = await async_client.delete(path, headers=bad_headers)
        else:
            continue

        msg = f"{method} {path} returned {resp.status_code}, expected 401"
        assert resp.status_code == HTTPStatus.UNAUTHORIZED, msg


# ── Flow 5: Multi-habit streak building across completions ─────────────


@pytest.mark.asyncio
async def test_streak_builds_then_resets_on_miss(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Build a streak of 3, then miss once, verifying the streak resets to 0."""
    headers, user_id = await _signup(async_client, "flow5")

    # Create habit + goal
    habit_resp = await async_client.post(
        "/habits/", json=_habit_payload(name="Running"), headers=headers
    )
    habit_id = habit_resp.json()["id"]

    goal = Goal(
        habit_id=habit_id,
        title="Run daily",
        tier="clear",
        target=30.0,
        target_unit="minutes",
        frequency=1.0,
        frequency_unit="per_day",
        is_additive=True,
    )
    db_session.add(goal)
    await db_session.commit()
    await db_session.refresh(goal)

    # Build streak to 3
    expected_streaks = [1, 2, 3]
    for expected in expected_streaks:
        resp = await async_client.post(
            "/goal_completions/",
            json={"goal_id": goal.id, "did_complete": True},
            headers=headers,
        )
        assert resp.json()["streak"] == expected

    # Verify milestone at 3 includes threshold 3
    third_resp = resp.json()
    assert {"threshold": 3} in third_resp["milestones"]

    # Miss resets to 0
    miss_resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": False},
        headers=headers,
    )
    assert miss_resp.json()["streak"] == 0
    assert miss_resp.json()["reason_code"] == "streak_reset"
