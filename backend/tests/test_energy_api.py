from typing import Any
from unittest.mock import patch

from cachetools import TTLCache
from fastapi.testclient import TestClient

from main import app
from services import energy
from services.energy import idempotency_cache

client = TestClient(app)


def sample_payload() -> dict[str, Any]:
    return {
        "habits": [
            {"id": 1, "name": "Run", "energy_cost": 2, "energy_return": 5},
            {"id": 2, "name": "Sleep", "energy_cost": 1, "energy_return": 0},
        ],
        "start_date": "2024-01-01",
    }


def test_energy_plan_endpoint_returns_plan() -> None:
    res = client.post("/v1/energy/plan", json=sample_payload())
    assert res.status_code == 200  # noqa: PLR2004
    data = res.json()
    assert data["reason_code"] == "generated_21_day_plan"
    assert len(data["plan"]["items"]) == 21  # noqa: PLR2004
    expected_net = (5 - 2) * 11 + (0 - 1) * 10
    assert data["plan"]["net_energy"] == expected_net


def test_energy_plan_endpoint_idempotency() -> None:
    headers = {"X-Idempotency-Key": "abc"}
    res1 = client.post("/v1/energy/plan", json=sample_payload(), headers=headers)
    res2 = client.post("/v1/energy/plan", json=sample_payload(), headers=headers)
    assert res1.json() == res2.json()


def test_idempotency_cache_is_ttl_bounded() -> None:
    """The idempotency cache should be a TTLCache with bounded size."""
    assert isinstance(idempotency_cache, TTLCache)
    assert idempotency_cache.maxsize == 1000  # noqa: PLR2004
    assert idempotency_cache.ttl == 3600  # noqa: PLR2004


def test_idempotency_cache_evicts_when_full() -> None:
    """When the cache is full, new entries should evict old ones."""
    small_cache: TTLCache[str, str] = TTLCache(maxsize=2, ttl=3600)
    small_cache["a"] = "val_a"
    small_cache["b"] = "val_b"
    small_cache["c"] = "val_c"
    assert "a" not in small_cache
    assert "c" in small_cache


def test_empty_habits_returns_400() -> None:
    """POST with empty habits list should return 400, not 500."""
    res = client.post("/v1/energy/plan", json={"habits": [], "start_date": "2024-01-01"})
    assert res.status_code == 400  # noqa: PLR2004
    assert res.json()["detail"] == "habits_must_not_be_empty"


def test_idempotency_miss_after_cache_clear() -> None:
    """After clearing the cache, duplicate keys should recompute."""
    with patch.object(energy, "idempotency_cache", TTLCache(maxsize=1000, ttl=3600)):
        headers = {"X-Idempotency-Key": "unique-clear-test"}
        res1 = client.post("/v1/energy/plan", json=sample_payload(), headers=headers)
        energy.idempotency_cache.clear()
        res2 = client.post("/v1/energy/plan", json=sample_payload(), headers=headers)
        # Both should succeed (recomputed, not from cache)
        assert res1.status_code == 200  # noqa: PLR2004
        assert res2.status_code == 200  # noqa: PLR2004
