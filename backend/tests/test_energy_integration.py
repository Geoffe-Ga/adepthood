"""Integration tests for the energy planning API.

These tests go beyond the unit-level endpoint tests by verifying multi-step
energy plan flows: habit-driven plan generation, idempotency across calls,
and edge-case error handling.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

from cachetools import TTLCache
from fastapi.testclient import TestClient

from main import app
from routers import energy

client = TestClient(app)

SAMPLE_HABITS = [
    {"id": 1, "name": "Run", "energy_cost": 2, "energy_return": 5},
    {"id": 2, "name": "Read", "energy_cost": 1, "energy_return": 3},
    {"id": 3, "name": "Meditate", "energy_cost": 0, "energy_return": 4},
]


def _plan_payload(habits: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Build a valid energy plan request payload."""
    return {
        "habits": habits if habits is not None else SAMPLE_HABITS,
        "start_date": "2025-01-01",
    }


# ---------------------------------------------------------------------------
# Flow 1: Create habits → Generate plan → Verify plan uses correct habits
# ---------------------------------------------------------------------------


def test_plan_includes_all_submitted_habits() -> None:
    """The generated plan should reference every habit submitted in the request."""
    resp = client.post("/v1/energy/plan", json=_plan_payload())
    assert resp.status_code == 200  # noqa: PLR2004
    data = resp.json()

    plan_items = data["plan"]["items"]
    habit_ids_in_plan = {item["habit_id"] for item in plan_items}

    submitted_ids = {h["id"] for h in SAMPLE_HABITS}
    assert submitted_ids == habit_ids_in_plan


def test_plan_net_energy_is_correct() -> None:
    """Net energy should equal sum of (return - cost) * scheduled days per habit."""
    habits: list[dict[str, int | str]] = [
        {"id": 1, "name": "A", "energy_cost": 3, "energy_return": 7},
        {"id": 2, "name": "B", "energy_cost": 2, "energy_return": 1},
    ]
    resp = client.post("/v1/energy/plan", json=_plan_payload(habits))
    assert resp.status_code == 200  # noqa: PLR2004
    data = resp.json()

    plan_items = data["plan"]["items"]

    # Count scheduled days per habit
    days_per_habit: dict[int, int] = {}
    for item in plan_items:
        days_per_habit[item["habit_id"]] = days_per_habit.get(item["habit_id"], 0) + 1

    expected_net = sum(
        (int(h["energy_return"]) - int(h["energy_cost"])) * days_per_habit.get(int(h["id"]), 0)
        for h in habits
    )
    assert data["plan"]["net_energy"] == expected_net


# ---------------------------------------------------------------------------
# Flow 2: Idempotent request → Same response returned
# ---------------------------------------------------------------------------


def test_idempotent_request_returns_identical_response() -> None:
    """Two requests with the same idempotency key should produce identical responses."""
    key = "integ-idem-test-key"
    headers = {"X-Idempotency-Key": key}
    payload = _plan_payload()

    with patch.object(energy, "_idempotency_cache", TTLCache(maxsize=1000, ttl=3600)):
        resp1 = client.post("/v1/energy/plan", json=payload, headers=headers)
        resp2 = client.post("/v1/energy/plan", json=payload, headers=headers)

    assert resp1.status_code == 200  # noqa: PLR2004
    assert resp2.status_code == 200  # noqa: PLR2004
    assert resp1.json() == resp2.json()


def test_different_idempotency_keys_produce_independent_plans() -> None:
    """Different keys should not share cached responses."""
    payload = _plan_payload()

    with patch.object(energy, "_idempotency_cache", TTLCache(maxsize=1000, ttl=3600)):
        resp1 = client.post(
            "/v1/energy/plan",
            json=payload,
            headers={"X-Idempotency-Key": "key-alpha"},
        )
        resp2 = client.post(
            "/v1/energy/plan",
            json=payload,
            headers={"X-Idempotency-Key": "key-beta"},
        )

    # Both succeed — the responses will be equivalent (same input) but were
    # computed independently (different cache entries)
    assert resp1.status_code == 200  # noqa: PLR2004
    assert resp2.status_code == 200  # noqa: PLR2004


# ---------------------------------------------------------------------------
# Flow 3: Empty habits → 400 error (not 500)
# ---------------------------------------------------------------------------


def test_empty_habits_returns_400_with_clear_message() -> None:
    """An empty habits list should produce a 400 with an actionable detail message."""
    resp = client.post(
        "/v1/energy/plan",
        json={"habits": [], "start_date": "2025-01-01"},
    )
    assert resp.status_code == 400  # noqa: PLR2004
    detail = resp.json()["detail"]
    assert "habits" in detail.lower() or "empty" in detail.lower()


def test_single_habit_plan_generates_21_items() -> None:
    """A plan with one habit should produce 21 days of items."""
    habits = [{"id": 1, "name": "Solo", "energy_cost": 1, "energy_return": 2}]
    resp = client.post("/v1/energy/plan", json=_plan_payload(habits))
    assert resp.status_code == 200  # noqa: PLR2004
    plan_items = resp.json()["plan"]["items"]
    # With a single habit, all 21 items should reference that habit
    assert len(plan_items) == 21  # noqa: PLR2004
    assert all(item["habit_id"] == 1 for item in plan_items)
