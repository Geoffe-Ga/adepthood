"""Unit tests for :mod:`services.energy`: response building, persistence, resolution."""

from __future__ import annotations

from datetime import date
from http import HTTPStatus

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from domain.energy import Habit as DomainHabit
from models.energy_plan import EnergyPlan as EnergyPlanRecord
from models.habit import Habit
from schemas import EnergyPlanRequest
from services.energy import (
    _persist,
    build_energy_response,
    get_or_create_persisted_plan,
    resolve_trusted_habits,
)

_START = date(2025, 6, 1)


def _habits() -> list[DomainHabit]:
    """A minimal trusted habit list for response-building tests."""
    return [DomainHabit(id=1, name="Run", energy_cost=1, energy_return=3)]


async def _count_plans(session: AsyncSession, user_id: int) -> int:
    rows = await session.execute(
        select(EnergyPlanRecord).where(EnergyPlanRecord.user_id == user_id)
    )
    return len(rows.scalars().all())


def test_build_energy_response_returns_21_day_plan() -> None:
    response = build_energy_response(_habits(), _START)
    assert response.reason_code == "generated_21_day_plan"
    assert len(response.plan.items) == 21


def test_build_energy_response_raises_400_on_empty_habits() -> None:
    with pytest.raises(HTTPException) as excinfo:
        build_energy_response([], _START)
    assert excinfo.value.status_code == HTTPStatus.BAD_REQUEST
    assert excinfo.value.detail == "habits_must_not_be_empty"


# ── Durable plan persistence (audit-destub) ─────────────────────────────────


@pytest.mark.asyncio
async def test_keyed_retry_replays_the_persisted_plan(db_session: AsyncSession) -> None:
    """Two keyed calls write one row and return an identical plan (cross-restart).

    There is no in-memory cache anymore — the only shared state is the DB row,
    so the second call's match proves the read-through, i.e. the behaviour a
    fresh process / other worker would also see.
    """
    first = await get_or_create_persisted_plan(db_session, 1, _habits(), _START, "k1")
    second = await get_or_create_persisted_plan(db_session, 1, _habits(), _START, "k1")

    assert first == second
    assert await _count_plans(db_session, 1) == 1  # one row despite two calls


@pytest.mark.asyncio
async def test_keyed_retry_returns_stored_plan_ignoring_new_inputs(
    db_session: AsyncSession,
) -> None:
    """A retry with the same key replays the stored plan, never regenerating."""
    first = await get_or_create_persisted_plan(db_session, 1, _habits(), _START, "k")
    # Same key, different habits + start_date: the stored plan must win.
    other = [DomainHabit(id=2, name="Read", energy_cost=2, energy_return=9)]
    second = await get_or_create_persisted_plan(db_session, 1, other, date(2030, 1, 1), "k")

    assert second == first


@pytest.mark.asyncio
async def test_distinct_keys_produce_distinct_rows(db_session: AsyncSession) -> None:
    await get_or_create_persisted_plan(db_session, 1, _habits(), _START, "a")
    await get_or_create_persisted_plan(db_session, 1, _habits(), _START, "b")
    assert await _count_plans(db_session, 1) == 2


@pytest.mark.asyncio
async def test_same_key_different_users_are_isolated(db_session: AsyncSession) -> None:
    """The partial UNIQUE index is per (user, key), so users don't collide."""
    await get_or_create_persisted_plan(db_session, 1, _habits(), _START, "shared")
    await get_or_create_persisted_plan(db_session, 2, _habits(), _START, "shared")
    assert await _count_plans(db_session, 1) == 1
    assert await _count_plans(db_session, 2) == 1


@pytest.mark.asyncio
async def test_unkeyed_request_writes_a_row_each_call(db_session: AsyncSession) -> None:
    """Unkeyed requests are not deduplicated — each generated plan is recorded."""
    await get_or_create_persisted_plan(db_session, 1, _habits(), _START, None)
    await get_or_create_persisted_plan(db_session, 1, _habits(), _START, None)
    assert await _count_plans(db_session, 1) == 2


@pytest.mark.asyncio
async def test_persist_integrity_race_returns_stored_winner(db_session: AsyncSession) -> None:
    """A duplicate-key insert (concurrent winner exists) rolls back to the stored row.

    Exercises ``_persist``'s ``IntegrityError`` fallback directly: a row for
    ``(1, "race")`` already exists, so inserting another for the same key hits
    the partial UNIQUE index — the fallback must re-read and return the winner,
    not the losing response, leaving exactly one row.
    """
    winner = await get_or_create_persisted_plan(db_session, 1, _habits(), _START, "race")
    loser = build_energy_response(
        [DomainHabit(id=9, name="X", energy_cost=2, energy_return=9)], date(2030, 1, 1)
    )

    result = await _persist(db_session, 1, "race", loser)

    assert result == winner
    assert result != loser
    assert await _count_plans(db_session, 1) == 1


@pytest.mark.asyncio
async def test_persist_reraises_when_winner_not_readable(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the conflict has no readable winner after rollback, the error surfaces."""
    await get_or_create_persisted_plan(db_session, 1, _habits(), _START, "race2")

    async def _missing(*_args: object, **_kwargs: object) -> None:
        return None

    monkeypatch.setattr("services.energy._load_persisted_plan", _missing)
    loser = build_energy_response(_habits(), _START)

    with pytest.raises(IntegrityError):
        await _persist(db_session, 1, "race2", loser)


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
