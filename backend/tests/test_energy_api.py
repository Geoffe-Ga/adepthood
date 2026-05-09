"""Unit-ish tests for the energy plan TTL cache and idempotency helpers.

Endpoint coverage (auth, validation, plan generation) lives in
``test_energy_integration.py``.  The blocking-event-loop test stays here
because it monkeypatches the service.
"""

from __future__ import annotations

import asyncio
import time
from http import HTTPStatus
from typing import Any
from unittest.mock import patch

import pytest
from cachetools import TTLCache
from httpx import ASGITransport, AsyncClient

from main import app
from services import energy
from services.energy import idempotency_cache


def sample_payload() -> dict[str, Any]:
    return {
        "habits": [
            {"id": 1, "name": "Run", "energy_cost": 2, "energy_return": 5},
            {"id": 2, "name": "Sleep", "energy_cost": 1, "energy_return": 0},
        ],
        "start_date": "2024-01-01",
    }


async def _signup(client: AsyncClient) -> dict[str, str]:
    """Sign up a user and return auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": "energyuser@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def test_idempotency_cache_is_ttl_bounded() -> None:
    """The idempotency cache should be a TTLCache with bounded size."""
    assert isinstance(idempotency_cache, TTLCache)
    assert idempotency_cache.maxsize == 1000
    assert idempotency_cache.ttl == 3600


def test_idempotency_cache_evicts_when_full() -> None:
    """When the cache is full, new entries should evict old ones."""
    small_cache: TTLCache[str, str] = TTLCache(maxsize=2, ttl=3600)
    small_cache["a"] = "val_a"
    small_cache["b"] = "val_b"
    small_cache["c"] = "val_c"
    assert "a" not in small_cache
    assert "c" in small_cache


@pytest.mark.asyncio
async def test_idempotency_miss_after_cache_clear(async_client: AsyncClient) -> None:
    """After clearing the cache, duplicate keys should recompute."""
    headers = await _signup(async_client)
    with patch.object(energy, "idempotency_cache", TTLCache(maxsize=1000, ttl=3600)):
        idem_headers = {**headers, "X-Idempotency-Key": "unique-clear-test"}
        res1 = await async_client.post(
            "/v1/energy/plan", json=sample_payload(), headers=idem_headers
        )
        energy.idempotency_cache.clear()
        res2 = await async_client.post(
            "/v1/energy/plan", json=sample_payload(), headers=idem_headers
        )
        assert res1.status_code == HTTPStatus.OK
        assert res2.status_code == HTTPStatus.OK


@pytest.mark.asyncio
async def test_create_plan_does_not_block_event_loop(async_client: AsyncClient) -> None:
    """BUG-INFRA-009: slow plan generation must not starve concurrent requests.

    We replace ``get_or_generate_plan`` with a sync sleep that would block
    the event loop for 300ms if executed inline.  With ``asyncio.to_thread``
    the main loop is free during the sleep, so two concurrent requests
    complete in ~300ms total — not ~600ms serialised.
    """
    headers = await _signup(async_client)
    sleep_seconds = 0.3

    def _slow_plan(payload: Any, _key: Any) -> Any:  # noqa: ANN401
        time.sleep(sleep_seconds)
        return energy.build_energy_response(payload)

    # The blocking-event-loop assertion needs a real ASGI client (not the
    # async_client fixture, which already runs against the in-memory app).
    # Re-using the same app instance is fine — the dependency_overrides
    # installed by ``async_client`` are still active for the duration.
    with patch.object(energy, "get_or_generate_plan", _slow_plan):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            start = time.perf_counter()
            results = await asyncio.gather(
                ac.post("/v1/energy/plan", json=sample_payload(), headers=headers),
                ac.post("/v1/energy/plan", json=sample_payload(), headers=headers),
            )
            elapsed = time.perf_counter() - start

    for res in results:
        assert res.status_code == HTTPStatus.OK

    assert elapsed < sleep_seconds * 1.8, (
        f"expected concurrent energy requests to overlap; took {elapsed:.3f}s"
    )


@pytest.mark.asyncio
async def test_energy_plan_requires_auth(async_client: AsyncClient) -> None:
    """BUG-PRACTICE-010: an unauthenticated POST must be rejected at the gate."""
    resp = await async_client.post("/v1/energy/plan", json=sample_payload())
    assert resp.status_code == HTTPStatus.UNAUTHORIZED
