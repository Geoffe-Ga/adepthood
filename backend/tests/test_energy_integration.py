"""Integration tests for the energy plan API.

These tests exercise multi-step flows through the energy endpoint,
covering plan generation with varied habit sets, idempotency behavior,
and error handling for edge cases.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

from cachetools import TTLCache
from fastapi.testclient import TestClient

from main import app
from routers import energy

client = TestClient(app)


def _habits_payload(habits: list[dict[str, Any]], start_date: str = "2024-01-01") -> dict[str, Any]:
    """Build an energy plan request with the given habits."""
    return {"habits": habits, "start_date": start_date}


def _make_habit(habit_id: int, name: str, cost: int, ret: int) -> dict[str, Any]:
    """Create a habit dict for the energy plan request."""
    return {"id": habit_id, "name": name, "energy_cost": cost, "energy_return": ret}


# ── Flow 1: Create habits → Generate plan → Verify plan uses habits ────


def test_multi_habit_plan_includes_all_habits() -> None:
    """A plan generated from multiple habits should schedule items for all of them."""
    habits = [
        _make_habit(1, "Running", 3, 7),
        _make_habit(2, "Reading", 1, 3),
        _make_habit(3, "Meditation", 2, 5),
    ]
    resp = client.post("/v1/energy/plan", json=_habits_payload(habits))
    assert resp.status_code == 200  # noqa: PLR2004
    data = resp.json()

    # Plan should contain items and have positive net energy
    plan_items = data["plan"]["items"]
    assert len(plan_items) > 0

    # All habits should appear in the plan
    scheduled_habit_ids = {item["habit_id"] for item in plan_items}
    assert scheduled_habit_ids == {1, 2, 3}


# ── Flow 2: Idempotent request → Same response returned ───────────────


def test_idempotent_request_returns_identical_response() -> None:
    """Two requests with the same idempotency key should return identical plans,
    even if the cache has other entries."""
    with patch.object(energy, "_idempotency_cache", TTLCache(maxsize=1000, ttl=3600)):
        habits = [_make_habit(1, "Yoga", 2, 4)]
        payload = _habits_payload(habits)
        key = "integration-idempotency-test"
        headers = {"X-Idempotency-Key": key}

        first = client.post("/v1/energy/plan", json=payload, headers=headers)
        assert first.status_code == 200  # noqa: PLR2004

        # Second request with same key
        second = client.post("/v1/energy/plan", json=payload, headers=headers)
        assert second.status_code == 200  # noqa: PLR2004

        assert first.json() == second.json()

        # Different key produces a fresh response (values may match but it's recomputed)
        different = client.post(
            "/v1/energy/plan",
            json=payload,
            headers={"X-Idempotency-Key": "different-key"},
        )
        assert different.status_code == 200  # noqa: PLR2004


# ── Flow 3: Empty habits → 400 error (not 500) ────────────────────────


def test_empty_habits_returns_descriptive_400() -> None:
    """POST with an empty habits list should fail gracefully with a 400 status
    and a descriptive error detail, not a 500 server error."""
    resp = client.post("/v1/energy/plan", json=_habits_payload([]))
    assert resp.status_code == 400  # noqa: PLR2004
    detail = resp.json()["detail"]
    # The error message should be informative
    assert "habits" in detail.lower() or "empty" in detail.lower()


# ── Flow 4: Plan net energy is mathematically correct ──────────────────


def test_plan_net_energy_matches_habit_economics() -> None:
    """The plan's net_energy should reflect the correct sum of costs and returns
    across all scheduled items."""
    high_return_id = 1
    high_cost_id = 2
    high_return_cost, high_return_ret = 1, 10
    high_cost_cost, high_cost_ret = 8, 2

    habits = [
        _make_habit(high_return_id, "High Return", high_return_cost, high_return_ret),
        _make_habit(high_cost_id, "High Cost", high_cost_cost, high_cost_ret),
    ]
    resp = client.post("/v1/energy/plan", json=_habits_payload(habits))
    assert resp.status_code == 200  # noqa: PLR2004
    data = resp.json()

    plan_items = data["plan"]["items"]
    net_energy = data["plan"]["net_energy"]

    # Count how many times each habit is scheduled
    habit_1_count = sum(1 for item in plan_items if item["habit_id"] == high_return_id)
    habit_2_count = sum(1 for item in plan_items if item["habit_id"] == high_cost_id)

    # Net energy = sum of (return - cost) for each scheduled item
    expected_net = habit_1_count * (high_return_ret - high_return_cost) + habit_2_count * (
        high_cost_ret - high_cost_cost
    )
    assert net_energy == expected_net


# ── Flow 5: Single habit produces a valid 21-day plan ─────────────────


def test_single_habit_generates_valid_plan() -> None:
    """Even a single habit should produce a plan with the expected structure."""
    habits = [_make_habit(1, "Walking", 1, 3)]
    resp = client.post("/v1/energy/plan", json=_habits_payload(habits))
    assert resp.status_code == 200  # noqa: PLR2004
    data = resp.json()

    assert data["reason_code"] == "generated_21_day_plan"
    plan_items = data["plan"]["items"]

    # All items should reference the single habit
    assert all(item["habit_id"] == 1 for item in plan_items)

    # Each item should have a valid date
    for item in plan_items:
        assert "date" in item
        assert isinstance(item["date"], str)
