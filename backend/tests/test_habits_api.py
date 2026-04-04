"""Tests for the habits CRUD API — DB-backed with authentication."""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient


def sample_payload(**overrides: object) -> dict[str, object]:
    """Return a valid habit creation payload."""
    payload: dict[str, object] = {
        "name": "Drink Water",
        "icon": "💧",
        "start_date": "2024-01-01",
        "energy_cost": 1,
        "energy_return": 2,
        "notification_times": ["08:00"],
        "notification_frequency": "daily",
        "notification_days": ["mon"],
        "milestone_notifications": True,
        "sort_order": 1,
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
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")
    create_resp = await async_client.post("/habits/", json=sample_payload(), headers=alice_headers)
    habit_id = create_resp.json()["id"]
    resp = await async_client.get(f"/habits/{habit_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_user_cannot_delete_other_users_habit(async_client: AsyncClient) -> None:
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")
    create_resp = await async_client.post("/habits/", json=sample_payload(), headers=alice_headers)
    habit_id = create_resp.json()["id"]
    resp = await async_client.delete(f"/habits/{habit_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_get_nonexistent_habit_returns_404(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.get("/habits/9999", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND
