"""Tests for the per-goal CRUD API — DB-backed with authentication.

Goals are nested under habits and were originally only mutable via the
habits PUT endpoint, but ``HabitCreate`` does not include goal fields, so
target / target_unit / frequency / is_additive could not be updated from
the client.  This module covers the ``PUT /goals/{goal_id}`` endpoint
that closes that gap.
"""

from __future__ import annotations

from datetime import date
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.goal import Goal
from models.habit import Habit


async def _signup(client: AsyncClient, username: str = "goaluser") -> tuple[dict[str, str], int]:
    """Create a user and return ``(auth headers, user_id)``."""
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
        icon="\U0001f9d8",
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


def _update_payload(**overrides: object) -> dict[str, object]:
    """Default payload — every field the editor exposes."""
    payload: dict[str, object] = {
        "title": "Daily sit",
        "tier": "clear",
        "target": 20.0,
        "target_unit": "minutes",
        "frequency": 1.0,
        "frequency_unit": "per_day",
        "is_additive": True,
    }
    payload.update(overrides)
    return payload


# ── Unauthenticated + ownership ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_update_goal_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.put("/goals/1", json=_update_payload())
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_update_goal_404_when_goal_missing(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client)
    resp = await async_client.put("/goals/999", json=_update_payload(), headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_update_goal_403_when_caller_not_owner(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Cross-tenant probe: alice's goal cannot be updated by bob."""
    _, alice_id = await _signup(async_client, "alice")
    bob_headers, _ = await _signup(async_client, "bob")
    goal = await _seed_goal(db_session, alice_id, habit_name="Alice habit")

    resp = await async_client.put(f"/goals/{goal.id}", json=_update_payload(), headers=bob_headers)
    # Same 404 the not-found path returns — the IDOR remediation
    # (BUG-T7 / PR #265) collapses "doesn't exist" + "not yours" into a
    # single status to deny enumeration.
    assert resp.status_code in {HTTPStatus.NOT_FOUND, HTTPStatus.FORBIDDEN}


# ── Successful update ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_update_goal_persists_target(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client)
    goal = await _seed_goal(db_session, user_id)

    resp = await async_client.put(
        f"/goals/{goal.id}",
        json=_update_payload(target=42.0),
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["target"] == 42.0
    assert body["id"] == goal.id


@pytest.mark.asyncio
async def test_update_goal_persists_target_unit_frequency_and_is_additive(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The whole editor surface — unit / frequency / additive — round-trips."""
    headers, user_id = await _signup(async_client)
    goal = await _seed_goal(db_session, user_id)

    resp = await async_client.put(
        f"/goals/{goal.id}",
        json=_update_payload(
            target_unit="reps",
            frequency=3.0,
            frequency_unit="per_week",
            is_additive=False,
        ),
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["target_unit"] == "reps"
    assert body["frequency"] == 3.0
    assert body["frequency_unit"] == "per_week"
    assert body["is_additive"] is False


@pytest.mark.asyncio
async def test_update_goal_does_not_change_habit_id(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Caller cannot reparent a goal to a different habit via the PUT."""
    headers, user_id = await _signup(async_client)
    goal = await _seed_goal(db_session, user_id)
    original_habit_id = goal.habit_id

    # ``habit_id`` is intentionally absent from the GoalUpdate schema, so the
    # server should ignore any attempt to forge it. ``model_dump`` on the
    # request body strips unknown fields — assert the goal still belongs to
    # its original habit afterwards.
    resp = await async_client.put(
        f"/goals/{goal.id}",
        json={**_update_payload(target=99.0), "habit_id": 9999},
        headers=headers,
    )
    assert resp.status_code in {HTTPStatus.OK, HTTPStatus.UNPROCESSABLE_ENTITY}
    if resp.status_code == HTTPStatus.OK:
        assert resp.json()["habit_id"] == original_habit_id
