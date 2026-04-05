"""Integration tests for the energy planning flow.

Verifies that habit data feeds correctly into plan generation, idempotency
caching works as expected, and edge cases produce proper error responses.
"""

from __future__ import annotations

from http import HTTPStatus
from typing import Any

import pytest
from httpx import AsyncClient

from domain.energy import PLAN_DURATION_DAYS
from routers.energy import _idempotency_cache

_SOLO_HABIT_ID = 99
_TWO_HABIT_NET_ENERGY = 54  # Running(net=4) x 11 + Stretching(net=1) x 10


@pytest.fixture(autouse=True)
def _clear_energy_cache() -> None:
    """Ensure a clean idempotency cache for each test."""
    _idempotency_cache.clear()


_TWO_HABITS_PAYLOAD: dict[str, Any] = {
    "habits": [
        {"id": 1, "name": "Running", "energy_cost": 3, "energy_return": 7},
        {"id": 2, "name": "Stretching", "energy_cost": 1, "energy_return": 2},
    ],
    "start_date": "2025-06-01",
}


@pytest.mark.asyncio
class TestEnergyPlanIntegration:
    """Full async integration tests for the energy plan endpoint."""

    async def test_plan_structure_and_net_energy(self, async_client: AsyncClient) -> None:
        resp = await async_client.post("/v1/energy/plan", json=_TWO_HABITS_PAYLOAD)
        assert resp.status_code == HTTPStatus.OK

        data = resp.json()
        plan = data["plan"]
        assert data["reason_code"] == "generated_21_day_plan"
        assert len(plan["items"]) == PLAN_DURATION_DAYS

        # Habits cycle: index 0 = habit 1, index 1 = habit 2, ...
        habits_list = _TWO_HABITS_PAYLOAD["habits"]
        assert isinstance(habits_list, list)
        for i, item in enumerate(plan["items"]):
            expected_id = habits_list[i % len(habits_list)]["id"]
            assert item["habit_id"] == expected_id

        # Running (net=4) x 11 + Stretching (net=1) x 10 = 54
        assert plan["net_energy"] == _TWO_HABIT_NET_ENERGY

    async def test_idempotent_request_returns_same_response(
        self, async_client: AsyncClient
    ) -> None:
        idem_key = "test-idempotency-key-123"
        headers = {"X-Idempotency-Key": idem_key}

        resp1 = await async_client.post(
            "/v1/energy/plan", json=_TWO_HABITS_PAYLOAD, headers=headers
        )
        assert resp1.status_code == HTTPStatus.OK

        resp2 = await async_client.post(
            "/v1/energy/plan", json=_TWO_HABITS_PAYLOAD, headers=headers
        )
        assert resp2.status_code == HTTPStatus.OK
        assert resp1.json() == resp2.json()

    async def test_empty_habits_returns_400(self, async_client: AsyncClient) -> None:
        resp = await async_client.post(
            "/v1/energy/plan",
            json={"habits": [], "start_date": "2025-06-01"},
        )
        assert resp.status_code == HTTPStatus.BAD_REQUEST

    async def test_single_habit_fills_all_21_days(self, async_client: AsyncClient) -> None:
        payload = {
            "habits": [
                {"id": _SOLO_HABIT_ID, "name": "Solo", "energy_cost": 2, "energy_return": 3},
            ],
            "start_date": "2025-06-01",
        }
        resp = await async_client.post("/v1/energy/plan", json=payload)
        assert resp.status_code == HTTPStatus.OK

        plan = resp.json()["plan"]
        assert len(plan["items"]) == PLAN_DURATION_DAYS
        assert all(item["habit_id"] == _SOLO_HABIT_ID for item in plan["items"])
        # Net energy: (3 - 2) x 21 = 21
        assert plan["net_energy"] == PLAN_DURATION_DAYS

    async def test_dates_are_sequential(self, async_client: AsyncClient) -> None:
        resp = await async_client.post("/v1/energy/plan", json=_TWO_HABITS_PAYLOAD)
        items = resp.json()["plan"]["items"]
        dates = [item["date"] for item in items]
        assert dates == sorted(dates)
        # All dates should be unique
        assert len(set(dates)) == PLAN_DURATION_DAYS
