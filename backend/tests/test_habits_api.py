"""Tests for the habits CRUD API — DB-backed with authentication."""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.goal import Goal


def sample_payload(**overrides: object) -> dict[str, object]:
    """Return a valid habit creation payload."""
    payload: dict[str, object] = {
        "name": "Drink Water",
        "icon": "💧",
        "start_date": "2024-01-01",
        "energy_cost": 1,
        "energy_return": 2,
        "stage": "aptitude",
        "notification_times": ["08:00"],
        "notification_frequency": "daily",
        "notification_days": ["mon"],
        "milestone_notifications": True,
        "sort_order": 1,
    }
    payload.update(overrides)
    return payload


def sample_goal_payload(**overrides: object) -> dict[str, object]:
    """Return a valid goal creation payload."""
    payload: dict[str, object] = {
        "title": "Drink 8 glasses",
        "tier": "clear",
        "target": 8,
        "target_unit": "glasses",
        "frequency": 1,
        "frequency_unit": "per_day",
        "is_additive": True,
    }
    payload.update(overrides)
    return payload


async def _signup(client: AsyncClient, username: str = "alice") -> dict[str, str]:
    """Create a user and return auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


# ── Unauthenticated access ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unauthenticated_create_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.post("/habits/", json=sample_payload())
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_unauthenticated_list_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.get("/habits/")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ── CRUD ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_habit(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post("/habits/", json=sample_payload(), headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["name"] == "Drink Water"
    assert data["notification_times"] == ["08:00"]
    assert data["id"] is not None


@pytest.mark.asyncio
async def test_list_habits_sorted(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await async_client.post(
        "/habits/", json=sample_payload(name="Two", sort_order=2), headers=headers
    )
    await async_client.post(
        "/habits/", json=sample_payload(name="One", sort_order=1), headers=headers
    )
    resp = await async_client.get("/habits/", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    names = [h["name"] for h in resp.json()]
    assert names == ["One", "Two"]


@pytest.mark.asyncio
async def test_get_habit(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    create_resp = await async_client.post("/habits/", json=sample_payload(), headers=headers)
    habit_id = create_resp.json()["id"]
    resp = await async_client.get(f"/habits/{habit_id}", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["name"] == "Drink Water"


@pytest.mark.asyncio
async def test_update_habit(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    create_resp = await async_client.post("/habits/", json=sample_payload(), headers=headers)
    habit_id = create_resp.json()["id"]
    resp = await async_client.put(
        f"/habits/{habit_id}", json=sample_payload(name="Updated"), headers=headers
    )
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["name"] == "Updated"


@pytest.mark.asyncio
async def test_delete_habit_returns_204(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    create_resp = await async_client.post("/habits/", json=sample_payload(), headers=headers)
    habit_id = create_resp.json()["id"]
    resp = await async_client.delete(f"/habits/{habit_id}", headers=headers)
    assert resp.status_code == HTTPStatus.NO_CONTENT
    # Confirm gone
    get_resp = await async_client.get(f"/habits/{habit_id}", headers=headers)
    assert get_resp.status_code == HTTPStatus.NOT_FOUND


# ── User isolation ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_user_cannot_see_other_users_habits(async_client: AsyncClient) -> None:
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")
    await async_client.post(
        "/habits/", json=sample_payload(name="Alice Habit"), headers=alice_headers
    )
    resp = await async_client.get("/habits/", headers=bob_headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == []


@pytest.mark.asyncio
async def test_user_cannot_get_other_users_habit(async_client: AsyncClient) -> None:
    """BUG-T7: cross-user GET returns 403 (was 404).  See ``tests/security/test_idor.py``."""
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")
    create_resp = await async_client.post("/habits/", json=sample_payload(), headers=alice_headers)
    habit_id = create_resp.json()["id"]
    resp = await async_client.get(f"/habits/{habit_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_user_cannot_delete_other_users_habit(async_client: AsyncClient) -> None:
    """BUG-T7: cross-user DELETE returns 403 (was 404)."""
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")
    create_resp = await async_client.post("/habits/", json=sample_payload(), headers=alice_headers)
    habit_id = create_resp.json()["id"]
    resp = await async_client.delete(f"/habits/{habit_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_get_nonexistent_habit_returns_404(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.get("/habits/9999", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


# ── Type alignment (phase-1-11) ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_habit_with_stage(async_client: AsyncClient) -> None:
    """Habits accept and return a 'stage' field."""
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/habits/", json=sample_payload(stage="aptitude"), headers=headers
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["stage"] == "aptitude"


@pytest.mark.asyncio
async def test_create_habit_defaults_streak_to_zero(async_client: AsyncClient) -> None:
    """New habits should have streak=0 in the response."""
    headers = await _signup(async_client)
    resp = await async_client.post("/habits/", json=sample_payload(), headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["streak"] == 0


@pytest.mark.asyncio
async def test_get_habit_includes_goals(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """GET /habits/{id} returns nested goals list."""
    headers = await _signup(async_client)
    create_resp = await async_client.post("/habits/", json=sample_payload(), headers=headers)
    habit_id = create_resp.json()["id"]

    # Insert a goal directly via DB
    goal = Goal(
        habit_id=habit_id,
        title="Drink 8 glasses",
        tier="clear",
        target=8,
        target_unit="glasses",
        frequency=1,
        frequency_unit="per_day",
        is_additive=True,
    )
    db_session.add(goal)
    await db_session.commit()

    resp = await async_client.get(f"/habits/{habit_id}", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert "goals" in data
    assert len(data["goals"]) == 1
    assert data["goals"][0]["title"] == "Drink 8 glasses"


@pytest.mark.asyncio
async def test_list_habits_includes_goals(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """GET /habits/ returns nested goals in each habit."""
    headers = await _signup(async_client)
    create_resp = await async_client.post("/habits/", json=sample_payload(), headers=headers)
    habit_id = create_resp.json()["id"]

    goal = Goal(
        habit_id=habit_id,
        title="Drink 8 glasses",
        tier="clear",
        target=8,
        target_unit="glasses",
        frequency=1,
        frequency_unit="per_day",
        is_additive=True,
    )
    db_session.add(goal)
    await db_session.commit()

    resp = await async_client.get("/habits/", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    habits_list = resp.json()
    assert len(habits_list) == 1
    assert len(habits_list[0]["goals"]) == 1


@pytest.mark.asyncio
async def test_invalid_notification_frequency_rejected(async_client: AsyncClient) -> None:
    """notification_frequency must be one of daily/weekly/custom/off or null."""
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/habits/",
        json=sample_payload(notification_frequency="every_two_hours"),
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
