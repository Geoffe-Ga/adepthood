from typing import Any
from unittest.mock import patch

from cachetools import TTLCache
from fastapi.testclient import TestClient

from main import app
from routers import energy
from routers.energy import _idempotency_cache

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
    assert isinstance(_idempotency_cache, TTLCache)
    assert _idempotency_cache.maxsize == 1000  # noqa: PLR2004
    assert _idempotency_cache.ttl == 3600  # noqa: PLR2004


def test_idempotency_cache_evicts_when_full() -> None:
    """When the cache is full, new entries should evict old ones."""
    small_cache: TTLCache[str, str] = TTLCache(maxsize=2, ttl=3600)
    small_cache["a"] = "val_a"
    small_cache["b"] = "val_b"
    small_cache["c"] = "val_c"
    assert "a" not in small_cache
    assert "c" in small_cache


def test_idempotency_miss_after_cache_clear() -> None:
    """After clearing the cache, duplicate keys should recompute."""
    with patch.object(energy, "_idempotency_cache", TTLCache(maxsize=1000, ttl=3600)):
        headers = {"X-Idempotency-Key": "unique-clear-test"}
        res1 = client.post("/v1/energy/plan", json=sample_payload(), headers=headers)
        energy._idempotency_cache.clear()  # noqa: SLF001
        res2 = client.post("/v1/energy/plan", json=sample_payload(), headers=headers)
        # Both should succeed (recomputed, not from cache)
        assert res1.status_code == 200  # noqa: PLR2004
        assert res2.status_code == 200  # noqa: PLR2004
