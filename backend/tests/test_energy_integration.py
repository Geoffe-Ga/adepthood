"""Integration tests for the energy planning system.

These exercise the energy plan endpoint with realistic habit data. Costs are
now loaded server-side from the caller's own ``Habit`` rows (BUG-PRACTICE-010),
so each plan-generating test seeds habits owned by the signed-up user and uses
their real ids; client-sent costs are ignored.
"""

from __future__ import annotations

import itertools
from datetime import date
from http import HTTPStatus
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.habit import Habit

# Per-user habit names are unique (ix_habit_user_lower_name_unique_test); a
# global counter keeps every seeded habit's name distinct within a test.
_habit_names = itertools.count()


async def _auth_headers(client: AsyncClient, suffix: str = "") -> tuple[dict[str, str], int]:
    """Sign up a user and return (auth headers, user_id)."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"energy{suffix}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, body["user_id"]


async def _seed_habit(
    db_session: AsyncSession, user_id: int, *, cost: int, ret: int, name: str | None = None
) -> int:
    """Persist a habit owned by ``user_id`` and return its id (unique name)."""
    habit = Habit(
        name=name or f"Habit-{next(_habit_names)}",
        icon="⭐",
        start_date=date(2025, 1, 1),
        stage="1",
        streak=0,
        energy_cost=cost,
        energy_return=ret,
        user_id=user_id,
    )
    db_session.add(habit)
    await db_session.commit()
    await db_session.refresh(habit)
    assert habit.id is not None
    return habit.id


def _plan_request(ids: list[int], start_date: str = "2025-01-01") -> dict[str, Any]:
    """Build a request referencing habit ids (costs omitted — loaded server-side)."""
    return {
        "habits": [{"id": habit_id, "name": f"Habit {habit_id}"} for habit_id in ids],
        "start_date": start_date,
    }


@pytest.mark.asyncio
async def test_energy_plan_generates_21_day_plan(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Energy plan endpoint generates a 21-day plan cycling through the caller's habits."""
    headers, user_id = await _auth_headers(async_client, "21day")
    ids = [
        await _seed_habit(db_session, user_id, cost=1, ret=2),
        await _seed_habit(db_session, user_id, cost=2, ret=4),
        await _seed_habit(db_session, user_id, cost=3, ret=6),
    ]

    resp = await async_client.post("/v1/energy/plan", json=_plan_request(ids), headers=headers)
    assert resp.status_code == HTTPStatus.OK

    items = resp.json()["plan"]["items"]
    assert len(items) == 21
    for i, item in enumerate(items):
        assert item["habit_id"] == ids[i % len(ids)]


@pytest.mark.asyncio
async def test_energy_plan_uses_stored_costs_not_forged(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A forged client cost does not change the plan — stored costs win (BUG-PRACTICE-010)."""
    headers, user_id = await _auth_headers(async_client, "forged")
    habit_id = await _seed_habit(db_session, user_id, cost=2, ret=3)
    payload = {
        "habits": [{"id": habit_id, "name": "Forged", "energy_cost": 999, "energy_return": 999}],
        "start_date": "2025-01-01",
    }

    resp = await async_client.post("/v1/energy/plan", json=payload, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    # 21 days * (3 - 2) = 21, NOT a forged value.
    assert resp.json()["plan"]["net_energy"] == 21


@pytest.mark.asyncio
async def test_energy_plan_net_energy_calculation(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Net energy is the sum of (return - cost) per scheduled day, from stored costs."""
    headers, user_id = await _auth_headers(async_client, "net")
    ids = [
        await _seed_habit(db_session, user_id, cost=3, ret=8, name="Run"),
        await _seed_habit(db_session, user_id, cost=1, ret=4, name="Read"),
    ]

    resp = await async_client.post("/v1/energy/plan", json=_plan_request(ids), headers=headers)
    assert resp.status_code == HTTPStatus.OK

    # 21 days: habit 0 on 11 days, habit 1 on 10 days.
    expected_net = 11 * (8 - 3) + 10 * (4 - 1)
    assert resp.json()["plan"]["net_energy"] == expected_net


@pytest.mark.asyncio
async def test_energy_plan_rejects_unowned_habit(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Referencing a habit owned by another user returns 403, not a plan."""
    _, owner_id = await _auth_headers(async_client, "owner")
    habit_id = await _seed_habit(db_session, owner_id, cost=1, ret=2)
    attacker_headers, _ = await _auth_headers(async_client, "attacker")

    resp = await async_client.post(
        "/v1/energy/plan", json=_plan_request([habit_id]), headers=attacker_headers
    )
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_energy_plan_rejects_nonexistent_habit(async_client: AsyncClient) -> None:
    """Referencing a habit id that exists for nobody returns 404."""
    headers, _ = await _auth_headers(async_client, "ghost")
    resp = await async_client.post("/v1/energy/plan", json=_plan_request([99999]), headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_idempotency_returns_cached_response(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Same idempotency key returns identical response without recomputation."""
    auth, user_id = await _auth_headers(async_client, "idem")
    ids = [await _seed_habit(db_session, user_id, cost=1, ret=2)]
    headers = {**auth, "X-Idempotency-Key": "test-idempotency-key-123"}
    payload = _plan_request(ids)

    resp1 = await async_client.post("/v1/energy/plan", json=payload, headers=headers)
    resp2 = await async_client.post("/v1/energy/plan", json=payload, headers=headers)

    assert resp1.status_code == HTTPStatus.OK
    assert resp2.status_code == HTTPStatus.OK
    assert resp1.json() == resp2.json()


@pytest.mark.asyncio
async def test_different_idempotency_keys_produce_independent_results(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Different idempotency keys persist independent plans."""
    auth, user_id = await _auth_headers(async_client, "diffidem")
    id_a = await _seed_habit(db_session, user_id, cost=1, ret=2, name="A")
    id_b = await _seed_habit(db_session, user_id, cost=5, ret=1, name="B")
    resp_a = await async_client.post(
        "/v1/energy/plan",
        json=_plan_request([id_a]),
        headers={**auth, "X-Idempotency-Key": "key-a"},
    )
    resp_b = await async_client.post(
        "/v1/energy/plan",
        json=_plan_request([id_b]),
        headers={**auth, "X-Idempotency-Key": "key-b"},
    )

    assert resp_a.json()["plan"]["net_energy"] != resp_b.json()["plan"]["net_energy"]


@pytest.mark.asyncio
async def test_empty_habits_returns_400(async_client: AsyncClient) -> None:
    """POST with empty habits list returns 400, not 500."""
    headers, _ = await _auth_headers(async_client, "empty")
    resp = await async_client.post(
        "/v1/energy/plan",
        json={"habits": [], "start_date": "2025-01-01"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST
    assert resp.json()["detail"] == "habits_must_not_be_empty"


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["energy_cost", "energy_return"])
async def test_negative_energy_value_rejected(async_client: AsyncClient, field: str) -> None:
    """BUG-SCHEMA-007: clients can't smuggle negative energy values past Pydantic."""
    headers, _ = await _auth_headers(async_client, f"neg{field}")
    habit: dict[str, Any] = {"id": 1, "name": "X", field: -1}
    resp = await async_client.post(
        "/v1/energy/plan",
        json={"habits": [habit], "start_date": "2025-01-01"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["energy_cost", "energy_return"])
async def test_oversized_energy_value_rejected(async_client: AsyncClient, field: str) -> None:
    """BUG-SCHEMA-007: values above the documented cap are rejected, not clamped."""
    headers, _ = await _auth_headers(async_client, f"big{field}")
    habit: dict[str, Any] = {"id": 1, "name": "X", field: 10_001}
    resp = await async_client.post(
        "/v1/energy/plan",
        json={"habits": [habit], "start_date": "2025-01-01"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_zero_id_habit_rejected(async_client: AsyncClient) -> None:
    """``id`` must be positive — a zero id would never round-trip to a real habit."""
    headers, _ = await _auth_headers(async_client, "zeroid")
    resp = await async_client.post(
        "/v1/energy/plan",
        json={"habits": [{"id": 0, "name": "X"}], "start_date": "2025-01-01"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_too_many_habits_rejected(async_client: AsyncClient) -> None:
    """A pathological 101-habit payload is rejected before it hits the planner."""
    headers, _ = await _auth_headers(async_client, "many")
    too_many = [{"id": i + 1, "name": f"H{i}"} for i in range(101)]
    resp = await async_client.post(
        "/v1/energy/plan",
        json={"habits": too_many, "start_date": "2025-01-01"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_single_habit_fills_all_21_days(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A single habit is scheduled for all 21 days of the plan."""
    headers, user_id = await _auth_headers(async_client, "single")
    habit_id = await _seed_habit(db_session, user_id, cost=2, ret=3, name="Solo")

    resp = await async_client.post(
        "/v1/energy/plan", json=_plan_request([habit_id]), headers=headers
    )
    assert resp.status_code == HTTPStatus.OK

    items = resp.json()["plan"]["items"]
    assert len(items) == 21
    assert all(item["habit_id"] == habit_id for item in items)
    assert resp.json()["plan"]["net_energy"] == 21  # 21 * (3 - 2)
