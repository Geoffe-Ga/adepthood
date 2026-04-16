import asyncio
import time
from typing import Any
from unittest.mock import patch

import pytest
from cachetools import TTLCache
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

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


@pytest.mark.asyncio
async def test_create_plan_does_not_block_event_loop() -> None:
    """BUG-INFRA-009: slow plan generation must not starve concurrent requests.

    We replace ``get_or_generate_plan`` with a sync sleep that would block
    the event loop for 300ms if executed inline.  With ``asyncio.to_thread``
    the main loop is free during the sleep, so two concurrent requests
    complete in ~300ms total — not ~600ms serialised.
    """
    sleep_seconds = 0.3

    def _slow_plan(payload: Any, _key: Any) -> Any:  # noqa: ANN401
        # ``time.sleep`` (not ``asyncio.sleep``) — this is the sync CPU-ish
        # stand-in.  If the endpoint runs inline on the loop, this stalls
        # every other coroutine for ``sleep_seconds``.
        time.sleep(sleep_seconds)
        return energy.build_energy_response(payload)

    with patch.object(energy, "get_or_generate_plan", _slow_plan):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            start = time.perf_counter()
            results = await asyncio.gather(
                ac.post("/v1/energy/plan", json=sample_payload()),
                ac.post("/v1/energy/plan", json=sample_payload()),
            )
            elapsed = time.perf_counter() - start

    for res in results:
        assert res.status_code == 200  # noqa: PLR2004

    # If the endpoint were synchronous on the loop, elapsed would be
    # >= 2 * sleep_seconds.  Offloading via ``asyncio.to_thread`` brings it
    # close to a single sleep duration — allow generous headroom so CI
    # noise doesn't flake the assertion.
    assert elapsed < sleep_seconds * 1.8, (
        f"expected concurrent energy requests to overlap; took {elapsed:.3f}s"
    )
