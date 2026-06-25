"""Unit tests for :mod:`services.energy`: cache, response building, trusted-cost resolution."""

from __future__ import annotations

from datetime import date
from http import HTTPStatus

import pytest
from cachetools import TTLCache
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from domain.energy import Habit as DomainHabit
from models.habit import Habit
from schemas import EnergyPlanRequest
from services.energy import (
    CACHE_MAX_ENTRIES,
    CACHE_TTL_SECONDS,
    build_energy_response,
    get_or_generate_plan,
    idempotency_cache,
    resolve_trusted_habits,
)

_START = date(2025, 6, 1)


def _habits() -> list[DomainHabit]:
    """A minimal trusted habit list for response-building tests."""
    return [DomainHabit(id=1, name="Run", energy_cost=1, energy_return=3)]


def test_idempotency_cache_is_ttl_bounded() -> None:
    """The module-level cache should be a TTLCache with the documented limits."""
    assert isinstance(idempotency_cache, TTLCache)
    assert idempotency_cache.maxsize == CACHE_MAX_ENTRIES
    assert idempotency_cache.ttl == CACHE_TTL_SECONDS


def test_build_energy_response_returns_21_day_plan() -> None:
    response = build_energy_response(_habits(), _START)
    assert response.reason_code == "generated_21_day_plan"
    assert len(response.plan.items) == 21


def test_build_energy_response_raises_400_on_empty_habits() -> None:
    with pytest.raises(HTTPException) as excinfo:
        build_energy_response([], _START)
    assert excinfo.value.status_code == HTTPStatus.BAD_REQUEST
    assert excinfo.value.detail == "habits_must_not_be_empty"


def test_get_or_generate_plan_without_key_skips_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    """No idempotency key means no cache write — subsequent calls recompute."""
    fresh_cache: TTLCache[str, object] = TTLCache(maxsize=100, ttl=60)
    monkeypatch.setattr("services.energy.idempotency_cache", fresh_cache)

    get_or_generate_plan(_habits(), _START, idempotency_key=None)
    assert len(fresh_cache) == 0


def test_get_or_generate_plan_returns_cached_response_for_same_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fresh_cache: TTLCache[str, object] = TTLCache(maxsize=100, ttl=60)
    monkeypatch.setattr("services.energy.idempotency_cache", fresh_cache)

    first = get_or_generate_plan(_habits(), _START, idempotency_key="k")
    second = get_or_generate_plan(_habits(), _START, idempotency_key="k")

    assert first == second
    assert len(fresh_cache) == 1


# ── Server-side trusted-cost resolution (BUG-PRACTICE-010) ──────────────────


async def _make_habit(
    session: AsyncSession, user_id: int, *, energy_cost: int, energy_return: int
) -> int:
    """Persist a habit owned by ``user_id`` and return its id."""
    habit = Habit(
        name="Owned",
        icon="⭐",
        start_date=date(2025, 1, 1),
        stage="1",
        streak=0,
        energy_cost=energy_cost,
        energy_return=energy_return,
        user_id=user_id,
    )
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    assert habit.id is not None
    return habit.id


def _request(
    habit_id: int, *, cost: int | None = None, ret: int | None = None
) -> EnergyPlanRequest:
    return EnergyPlanRequest.model_validate(
        {
            "habits": [{"id": habit_id, "name": "x", "energy_cost": cost, "energy_return": ret}],
            "start_date": "2025-06-01",
        }
    )


@pytest.mark.asyncio
async def test_resolve_ignores_forged_client_costs(db_session: AsyncSession) -> None:
    """Forged client costs are ignored; the resolved habit carries the stored costs."""
    user_id = 1
    habit_id = await _make_habit(db_session, user_id, energy_cost=2, energy_return=9)
    payload = _request(habit_id, cost=1000, ret=0)  # client forges wildly different costs

    resolved = await resolve_trusted_habits(db_session, user_id, payload)

    assert len(resolved) == 1
    assert resolved[0].energy_cost == 2
    assert resolved[0].energy_return == 9


@pytest.mark.asyncio
async def test_resolve_works_when_costs_omitted(db_session: AsyncSession) -> None:
    """A payload omitting costs still resolves to the stored values."""
    user_id = 1
    habit_id = await _make_habit(db_session, user_id, energy_cost=4, energy_return=7)

    resolved = await resolve_trusted_habits(db_session, user_id, _request(habit_id))

    assert resolved[0].energy_cost == 4
    assert resolved[0].energy_return == 7


@pytest.mark.asyncio
async def test_resolve_rejects_habit_owned_by_another_user(db_session: AsyncSession) -> None:
    """A habit owned by someone else returns 403, not a plan."""
    owner_id, attacker_id = 1, 2
    habit_id = await _make_habit(db_session, owner_id, energy_cost=2, energy_return=3)

    with pytest.raises(HTTPException) as excinfo:
        await resolve_trusted_habits(db_session, attacker_id, _request(habit_id))
    assert excinfo.value.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_resolve_rejects_nonexistent_habit(db_session: AsyncSession) -> None:
    """A habit id that exists for nobody returns 404."""
    with pytest.raises(HTTPException) as excinfo:
        await resolve_trusted_habits(db_session, 1, _request(99999))
    assert excinfo.value.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_resolve_empty_payload_returns_empty(db_session: AsyncSession) -> None:
    """An empty habit list resolves to ``[]`` (empty-plan 400 happens downstream)."""
    payload = EnergyPlanRequest.model_validate({"habits": [], "start_date": "2025-06-01"})
    assert await resolve_trusted_habits(db_session, 1, payload) == []
