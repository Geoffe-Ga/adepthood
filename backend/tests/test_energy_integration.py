"""Integration tests for the energy planning system.

These tests exercise the energy plan endpoint with realistic habit data,
verifying plan generation, idempotency behavior, and error handling work
correctly together.
"""

from __future__ import annotations

from http import HTTPStatus
from typing import Any
from unittest.mock import patch

import pytest
from cachetools import TTLCache
from httpx import AsyncClient

from services import energy as energy_service


def _habits_payload(count: int = 3) -> list[dict[str, Any]]:
    """Generate a list of habit payloads for energy plan requests."""
    return [
        {
            "id": i + 1,
            "name": f"Habit {i + 1}",
            "energy_cost": i + 1,
            "energy_return": (i + 1) * 2,
        }
        for i in range(count)
    ]


def _plan_request(habits: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Build a complete energy plan request payload."""
    return {
        "habits": habits if habits is not None else _habits_payload(),
        "start_date": "2025-01-01",
    }


@pytest.mark.asyncio
async def test_energy_plan_generates_21_day_plan(async_client: AsyncClient) -> None:
    """Energy plan endpoint generates a 21-day plan cycling through habits."""
    resp = await async_client.post("/v1/energy/plan", json=_plan_request())
    assert resp.status_code == HTTPStatus.OK

    data = resp.json()
    assert data["reason_code"] == "generated_21_day_plan"

    plan = data["plan"]
    items = plan["items"]
    assert len(items) == 21

    # Verify items cycle through habits correctly
    habit_ids = [item["habit_id"] for item in items]
    for i, habit_id in enumerate(habit_ids):
        expected_habits = _habits_payload()
        expected_id = expected_habits[i % len(expected_habits)]["id"]
        assert habit_id == expected_id


@pytest.mark.asyncio
async def test_energy_plan_net_energy_calculation(async_client: AsyncClient) -> None:
    """Net energy is calculated correctly as sum of (return - cost) per day."""
    habits = [
        {"id": 1, "name": "Run", "energy_cost": 3, "energy_return": 8},
        {"id": 2, "name": "Read", "energy_cost": 1, "energy_return": 4},
    ]
    resp = await async_client.post("/v1/energy/plan", json=_plan_request(habits))
    assert resp.status_code == HTTPStatus.OK

    data = resp.json()
    # 21 days: habit 1 on days 0,2,4,...,20 (11 days), habit 2 on days 1,3,...,19 (10 days)
    # Net = 11 * (8-3) + 10 * (4-1) = 55 + 30 = 85
    expected_net = 11 * (8 - 3) + 10 * (4 - 1)
    assert data["plan"]["net_energy"] == expected_net


@pytest.mark.asyncio
async def test_idempotency_returns_cached_response(async_client: AsyncClient) -> None:
    """Same idempotency key returns identical response without recomputation."""
    headers = {"X-Idempotency-Key": "test-idempotency-key-123"}
    payload = _plan_request()

    resp1 = await async_client.post("/v1/energy/plan", json=payload, headers=headers)
    resp2 = await async_client.post("/v1/energy/plan", json=payload, headers=headers)

    assert resp1.status_code == HTTPStatus.OK
    assert resp2.status_code == HTTPStatus.OK
    assert resp1.json() == resp2.json()


@pytest.mark.asyncio
async def test_different_idempotency_keys_produce_independent_results(
    async_client: AsyncClient,
) -> None:
    """Different idempotency keys are cached independently."""
    with patch.object(energy_service, "idempotency_cache", TTLCache(maxsize=1000, ttl=3600)):
        payload_a = _plan_request([{"id": 1, "name": "A", "energy_cost": 1, "energy_return": 2}])
        payload_b = _plan_request([{"id": 2, "name": "B", "energy_cost": 5, "energy_return": 1}])

        resp_a = await async_client.post(
            "/v1/energy/plan",
            json=payload_a,
            headers={"X-Idempotency-Key": "key-a"},
        )
        resp_b = await async_client.post(
            "/v1/energy/plan",
            json=payload_b,
            headers={"X-Idempotency-Key": "key-b"},
        )

        assert resp_a.json()["plan"]["net_energy"] != resp_b.json()["plan"]["net_energy"]


@pytest.mark.asyncio
async def test_empty_habits_returns_400(async_client: AsyncClient) -> None:
    """POST with empty habits list returns 400, not 500."""
    resp = await async_client.post(
        "/v1/energy/plan",
        json={"habits": [], "start_date": "2025-01-01"},
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST
    assert resp.json()["detail"] == "habits_must_not_be_empty"


@pytest.mark.asyncio
async def test_single_habit_fills_all_21_days(async_client: AsyncClient) -> None:
    """A single habit is scheduled for all 21 days of the plan."""
    single = [{"id": 42, "name": "Solo", "energy_cost": 2, "energy_return": 3}]
    resp = await async_client.post("/v1/energy/plan", json=_plan_request(single))
    assert resp.status_code == HTTPStatus.OK

    items = resp.json()["plan"]["items"]
    assert len(items) == 21
    assert all(item["habit_id"] == 42 for item in items)

    # Net energy: 21 * (3 - 2) = 21
    assert resp.json()["plan"]["net_energy"] == 21
