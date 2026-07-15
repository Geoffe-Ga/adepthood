"""Tests for the energy plan endpoint's persistence and concurrency behaviour.

Auth/validation/plan-generation coverage lives in ``test_energy_integration.py``
and the service-level persistence tests in ``tests/services/test_energy.py``;
this file covers HTTP-layer idempotency and the BUG-INFRA-009 offload, both of
which monkeypatch the service.
"""

from __future__ import annotations

import asyncio
import threading
from datetime import date
from http import HTTPStatus
from typing import Any
from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from domain.energy import Habit as DomainHabit
from main import app
from models.energy_plan import EnergyPlan as EnergyPlanRecord
from models.habit import Habit
from routers import energy as energy_router
from schemas import EnergyPlanRequest, EnergyPlanResponse
from services import energy


def sample_payload() -> dict[str, Any]:
    """A valid-shape request (used by the no-auth test, which 401s before lookup)."""
    return {
        "habits": [{"id": 1, "name": "Run"}],
        "start_date": "2024-01-01",
    }


def _plan_request(ids: list[int]) -> dict[str, Any]:
    return {
        "habits": [{"id": habit_id, "name": f"H{habit_id}"} for habit_id in ids],
        "start_date": "2024-01-01",
    }


async def _signup(client: AsyncClient, username: str = "energyuser") -> tuple[dict[str, str], int]:
    """Sign up a user and return (auth headers, user_id)."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, body["user_id"]


async def _seed_habit(db_session: AsyncSession, user_id: int) -> int:
    """Persist a habit owned by ``user_id`` and return its id."""
    habit = Habit(
        name="Owned",
        icon="⭐",
        start_date=date(2025, 1, 1),
        stage="1",
        streak=0,
        energy_cost=2,
        energy_return=5,
        user_id=user_id,
    )
    db_session.add(habit)
    await db_session.commit()
    await db_session.refresh(habit)
    assert habit.id is not None
    return habit.id


@pytest.mark.asyncio
async def test_keyed_requests_replay_identical_persisted_plan(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Two POSTs with the same X-Idempotency-Key return one plan, one stored row."""
    headers, user_id = await _signup(async_client)
    habit_id = await _seed_habit(db_session, user_id)
    payload = _plan_request([habit_id])
    idem_headers = {**headers, "X-Idempotency-Key": "k-http"}

    res1 = await async_client.post("/v1/energy/plan", json=payload, headers=idem_headers)
    res2 = await async_client.post("/v1/energy/plan", json=payload, headers=idem_headers)

    assert res1.status_code == HTTPStatus.OK
    assert res2.status_code == HTTPStatus.OK
    assert res1.json() == res2.json()
    rows = await db_session.execute(
        select(EnergyPlanRecord).where(EnergyPlanRecord.user_id == user_id)
    )
    assert len(rows.scalars().all()) == 1  # deduplicated, not regenerated


@pytest.mark.asyncio
async def test_create_plan_does_not_block_event_loop(async_client: AsyncClient) -> None:
    """BUG-INFRA-009: slow plan generation must not starve concurrent requests.

    ``get_or_create_persisted_plan`` runs the CPU-bound ``build_energy_response``
    via ``asyncio.to_thread``, so two concurrent requests must have their builds
    in flight *at the same time* rather than serialised on the event loop. This
    is asserted deterministically — not by a wall-clock budget: the stubbed build
    performs a two-party handshake (a ``threading.Barrier``) so that each build
    blocks until its sibling has also entered, then records peak overlap. If the
    offload regressed to an inline call the loop would be blocked, only one build
    could ever be in flight, the barrier would time out, and the request would
    fail. ``_persist`` and the habit lookup are stubbed to isolate the offload
    from the DB.
    """
    headers, _ = await _signup(async_client)
    expected_overlap = 2  # both concurrent requests build simultaneously
    # Generous deadlock guard, not a speed budget: when the loop is *not* blocked
    # the barrier releases the instant the sibling build enters (microseconds,
    # independent of runner speed); this bound only trips if a regression forces
    # the builds to run serially, so it is immune to slow-CI flake.
    handshake_timeout_seconds = 10.0
    one_habit = [DomainHabit(id=1, name="Run", energy_cost=2, energy_return=5)]
    real_response = energy.build_energy_response(one_habit, date(2024, 1, 1))

    both_builds_entered = threading.Barrier(expected_overlap, timeout=handshake_timeout_seconds)
    concurrency_lock = threading.Lock()
    active_builds = 0
    peak_builds = 0

    async def _stub_resolve(
        _session: AsyncSession, _user_id: int, _payload: EnergyPlanRequest
    ) -> list[DomainHabit]:
        return one_habit

    def _handshake_build(_habits: list[DomainHabit], _start: date) -> EnergyPlanResponse:
        nonlocal active_builds, peak_builds
        with concurrency_lock:
            active_builds += 1
            peak_builds = max(peak_builds, active_builds)
        both_builds_entered.wait()  # blocks until the sibling build is also in flight
        with concurrency_lock:
            active_builds -= 1
        return real_response

    async def _noop_persist(
        _session: AsyncSession,
        _user_id: int,
        _key: str | None,
        response: EnergyPlanResponse,
    ) -> EnergyPlanResponse:
        return response

    with (
        patch.object(energy_router, "resolve_trusted_habits", _stub_resolve),
        patch.object(energy, "build_energy_response", _handshake_build),
        patch.object(energy, "_persist", _noop_persist),
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            results = await asyncio.gather(
                ac.post("/v1/energy/plan", json=sample_payload(), headers=headers),
                ac.post("/v1/energy/plan", json=sample_payload(), headers=headers),
            )

    for res in results:
        assert res.status_code == HTTPStatus.OK

    assert peak_builds == expected_overlap, (
        f"expected {expected_overlap} energy builds in flight at once; "
        f"peak overlap was {peak_builds} (event loop appears blocked)"
    )


@pytest.mark.asyncio
async def test_energy_plan_requires_auth(async_client: AsyncClient) -> None:
    """BUG-PRACTICE-010: an unauthenticated POST must be rejected at the gate."""
    resp = await async_client.post("/v1/energy/plan", json=sample_payload())
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_over_long_idempotency_key_rejected(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An X-Idempotency-Key longer than the column width 422s, not a DB error."""
    headers, user_id = await _signup(async_client)
    habit_id = await _seed_habit(db_session, user_id)
    resp = await async_client.post(
        "/v1/energy/plan",
        json=_plan_request([habit_id]),
        headers={**headers, "X-Idempotency-Key": "x" * 256},
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
