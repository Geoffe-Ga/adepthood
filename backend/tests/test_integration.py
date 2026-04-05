"""Multi-step integration tests that exercise end-to-end user flows.

Unlike unit tests that test individual endpoints in isolation, these tests
verify that multiple API calls compose correctly — e.g., signup → create habit
→ log completion → verify progress and milestones.
"""

from __future__ import annotations

from http import HTTPStatus

import jwt
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.goal import Goal
from models.practice import Practice

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _signup(client: AsyncClient, username: str = "integ") -> tuple[dict[str, str], int]:
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
        "energy_cost": 5,
        "energy_return": 10,
        "stage": "aptitude",
    }
    payload.update(overrides)
    return payload


async def _seed_goal(db_session: AsyncSession, habit_id: int) -> Goal:
    """Insert a goal for the given habit and return it."""
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


async def _seed_practice(db_session: AsyncSession) -> Practice:
    """Insert an approved practice and return it."""
    practice = Practice(
        stage_number=1,
        name="Breath Focus",
        description="Basic breathing exercise",
        instructions="Inhale for 4, hold for 4, exhale for 4.",
        default_duration_minutes=10,
        approved=True,
    )
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)
    return practice


# ---------------------------------------------------------------------------
# Flow 1: Signup → Create habit → Log completion → Check progress → Milestone
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_full_habit_completion_flow(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Signup → create habit → seed goal → log completions → verify streak & milestones."""
    headers, _user_id = await _signup(async_client, "flow1")

    # 1. Create a habit
    create_resp = await async_client.post("/habits/", json=_habit_payload(), headers=headers)
    assert create_resp.status_code == HTTPStatus.OK
    habit_id = create_resp.json()["id"]

    # 2. Seed a goal for the habit (via DB because goal creation isn't an API)
    goal = await _seed_goal(db_session, habit_id)

    # 3. First completion — streak goes to 1, milestone at threshold 1 triggered
    resp1 = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )
    assert resp1.status_code == HTTPStatus.OK
    data1 = resp1.json()
    assert data1["streak"] == 1
    assert data1["reason_code"] == "streak_incremented"
    assert {"threshold": 1} in data1["milestones"]

    # 4. Second and third completions — streak builds
    for expected_streak in (2, 3):
        resp = await async_client.post(
            "/goal_completions/",
            json={"goal_id": goal.id, "did_complete": True},
            headers=headers,
        )
        assert resp.status_code == HTTPStatus.OK
        assert resp.json()["streak"] == expected_streak

    # 5. Verify the 3-day milestone was reached
    resp3 = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )
    data3 = resp3.json()
    # After 4 completions, streak is 4 → milestones at 1 and 3 are reached
    milestone_1 = 1
    milestone_3 = 3
    milestones = [m["threshold"] for m in data3["milestones"]]
    assert milestone_1 in milestones
    assert milestone_3 in milestones

    # 6. Verify the habit still appears in the list
    list_resp = await async_client.get("/habits/", headers=headers)
    assert list_resp.status_code == HTTPStatus.OK
    habit_names = [h["name"] for h in list_resp.json()]
    assert "Meditation" in habit_names


# ---------------------------------------------------------------------------
# Flow 2: Create multiple habits → Reorder → Verify sort order persisted
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_habit_reorder_persists(async_client: AsyncClient) -> None:
    """Create habits with sort_order, verify they come back in that order."""
    headers, _user_id = await _signup(async_client, "reorder")

    # Create three habits with explicit sort order
    for name, order in [("C-Third", 3), ("A-First", 1), ("B-Second", 2)]:
        resp = await async_client.post(
            "/habits/",
            json=_habit_payload(name=name, sort_order=order),
            headers=headers,
        )
        assert resp.status_code == HTTPStatus.OK

    # List should be sorted by sort_order
    list_resp = await async_client.get("/habits/", headers=headers)
    assert list_resp.status_code == HTTPStatus.OK
    names = [h["name"] for h in list_resp.json()]
    assert names == ["A-First", "B-Second", "C-Third"]

    # Update the first habit to move it to position 4
    habit_id = list_resp.json()[0]["id"]
    resp = await async_client.put(
        f"/habits/{habit_id}",
        json=_habit_payload(name="A-First", sort_order=4),
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK

    # Verify new order
    list_resp2 = await async_client.get("/habits/", headers=headers)
    names2 = [h["name"] for h in list_resp2.json()]
    assert names2 == ["B-Second", "C-Third", "A-First"]


# ---------------------------------------------------------------------------
# Flow 3: Practice session → Week count verification
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_practice_session_week_count_flow(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Create practice → select it → log sessions → verify week count."""
    headers, _user_id = await _signup(async_client, "practice_flow")
    practice = await _seed_practice(db_session)

    # 1. Select the practice (create a user-practice)
    up_resp = await async_client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": 1},
        headers=headers,
    )
    assert up_resp.status_code == HTTPStatus.CREATED
    user_practice_id = up_resp.json()["id"]

    # 2. Log two practice sessions
    session_count = 2
    for i in range(session_count):
        sess_resp = await async_client.post(
            "/practice-sessions/",
            json={
                "user_practice_id": user_practice_id,
                "duration_minutes": 15.0 + i,
                "reflection": f"Session {i + 1} reflection",
            },
            headers=headers,
        )
        assert sess_resp.status_code == HTTPStatus.OK

    # 3. Check week count — both sessions are in the current week
    count_resp = await async_client.get("/practice-sessions/week-count", headers=headers)
    assert count_resp.status_code == HTTPStatus.OK
    assert count_resp.json()["count"] == session_count

    # 4. Verify sessions are listed correctly
    list_resp = await async_client.get(
        f"/practice-sessions/?user_practice_id={user_practice_id}",
        headers=headers,
    )
    assert list_resp.status_code == HTTPStatus.OK
    assert len(list_resp.json()) == session_count


# ---------------------------------------------------------------------------
# Flow 4: Expired token → All endpoints return 401
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_expired_token_returns_401_on_all_endpoints(
    async_client: AsyncClient,
) -> None:
    """An expired JWT should be rejected by every protected endpoint."""
    # Create a token that expired 1 hour ago
    expired_payload = {
        "sub": "999",
        "exp": 0,  # Unix epoch — long expired
        "iat": 0,
    }
    expired_token = jwt.encode(
        expired_payload,
        "test-secret-key-for-unit-tests-only",  # pragma: allowlist secret
        algorithm="HS256",
    )
    headers = {"Authorization": f"Bearer {expired_token}"}

    protected_endpoints = [
        ("GET", "/habits/"),
        ("POST", "/habits/"),
        ("GET", "/practice-sessions/week-count"),
        ("GET", "/user-practices/"),
        ("POST", "/goal_completions/"),
    ]

    for method, path in protected_endpoints:
        if method == "GET":
            resp = await async_client.get(path, headers=headers)
        else:
            resp = await async_client.post(path, json={}, headers=headers)
        msg = f"{method} {path} returned {resp.status_code}, expected 401"
        assert resp.status_code == HTTPStatus.UNAUTHORIZED, msg


# ---------------------------------------------------------------------------
# Flow 5: Miss breaks streak, then rebuild
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_streak_reset_and_rebuild(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Build a streak → miss → verify reset → rebuild from zero."""
    headers, _user_id = await _signup(async_client, "streak_rebuild")
    create_resp = await async_client.post("/habits/", json=_habit_payload(), headers=headers)
    habit_id = create_resp.json()["id"]
    goal = await _seed_goal(db_session, habit_id)

    # Build streak to 3
    for _ in range(3):
        await async_client.post(
            "/goal_completions/",
            json={"goal_id": goal.id, "did_complete": True},
            headers=headers,
        )

    # Miss — streak resets
    miss_resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": False},
        headers=headers,
    )
    assert miss_resp.json()["streak"] == 0
    assert miss_resp.json()["reason_code"] == "streak_reset"

    # Rebuild — streak goes back to 1
    rebuild_resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )
    assert rebuild_resp.json()["streak"] == 1
    assert rebuild_resp.json()["reason_code"] == "streak_incremented"
