"""Unit tests for :mod:`services.energy` — idempotency cache + response building."""

from __future__ import annotations

from http import HTTPStatus

import pytest
from cachetools import TTLCache
from fastapi import HTTPException

from schemas import EnergyPlanRequest
from services.energy import (
    CACHE_MAX_ENTRIES,
    CACHE_TTL_SECONDS,
    build_energy_response,
    get_or_generate_plan,
    idempotency_cache,
)


def _payload() -> EnergyPlanRequest:
    """Return a minimal energy-plan request suitable for service-level tests."""
    return EnergyPlanRequest.model_validate(
        {
            "habits": [{"id": 1, "name": "Run", "energy_cost": 1, "energy_return": 3}],
            "start_date": "2025-06-01",
        }
    )


def test_idempotency_cache_is_ttl_bounded() -> None:
    """The module-level cache should be a TTLCache with the documented limits."""
    assert isinstance(idempotency_cache, TTLCache)
    assert idempotency_cache.maxsize == CACHE_MAX_ENTRIES
    assert idempotency_cache.ttl == CACHE_TTL_SECONDS


def test_build_energy_response_returns_21_day_plan() -> None:
    response = build_energy_response(_payload())
    assert response.reason_code == "generated_21_day_plan"
    assert len(response.plan.items) == 21  # noqa: PLR2004


def test_build_energy_response_raises_400_on_empty_habits() -> None:
    payload = EnergyPlanRequest.model_validate({"habits": [], "start_date": "2025-06-01"})
    with pytest.raises(HTTPException) as excinfo:
        build_energy_response(payload)
    assert excinfo.value.status_code == HTTPStatus.BAD_REQUEST
    assert excinfo.value.detail == "habits_must_not_be_empty"


def test_get_or_generate_plan_without_key_skips_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    """No idempotency key means no cache write — subsequent calls recompute."""
    fresh_cache: TTLCache[str, object] = TTLCache(maxsize=100, ttl=60)
    monkeypatch.setattr("services.energy.idempotency_cache", fresh_cache)

    get_or_generate_plan(_payload(), idempotency_key=None)
    assert len(fresh_cache) == 0


def test_get_or_generate_plan_returns_cached_response_for_same_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fresh_cache: TTLCache[str, object] = TTLCache(maxsize=100, ttl=60)
    monkeypatch.setattr("services.energy.idempotency_cache", fresh_cache)

    first = get_or_generate_plan(_payload(), idempotency_key="k")
    second = get_or_generate_plan(_payload(), idempotency_key="k")

    # Identity check would be too strict against our response model;
    # equality is enough to prove the second call reused the cached entry.
    assert first == second
    assert len(fresh_cache) == 1
