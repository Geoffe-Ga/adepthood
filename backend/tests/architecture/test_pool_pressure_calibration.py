"""Calibrate the outbound-boundary signal against real connection-pool pressure."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import TimeoutError as SqlAlchemyTimeoutError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from tests.support.outbound_boundary import (
    ConnectionHeldAcrossOutboundCallError,
    Observation,
    assert_dialled_off_the_pool,
)

_POOL_TIMEOUT_SECONDS = 0.05
_TASK_TIMEOUT_SECONDS = 1.0


@dataclass
class _OutboundBarrier:
    """Pause a request at its simulated outbound dial and retain its observation."""

    entered: asyncio.Event = field(default_factory=asyncio.Event)
    release: asyncio.Event = field(default_factory=asyncio.Event)
    observations: list[Observation] = field(default_factory=list)


async def _request_at_outbound(
    sessions: async_sessionmaker[AsyncSession],
    barrier: _OutboundBarrier,
    *,
    release_before_dial: bool,
) -> None:
    """Open a transaction, then pause where a network request would await."""
    async with sessions() as session:
        await session.execute(text("SELECT 1"))
        if release_before_dial:
            await session.commit()
        barrier.observations.append(
            Observation(
                leaf="calibration.outbound",
                held=session.in_transaction(),
                live_sessions=1,
                frames=("test_pool_pressure_calibration:_request_at_outbound",),
            )
        )
        barrier.entered.set()
        await barrier.release.wait()


async def _probe_pool(sessions: async_sessionmaker[AsyncSession]) -> bool:
    """Return whether another request times out trying to check out the only slot."""
    try:
        async with sessions() as session:
            await session.execute(text("SELECT 1"))
    except SqlAlchemyTimeoutError:
        return True
    return False


async def _run_pressure_case(
    sessions: async_sessionmaker[AsyncSession], *, release_before_dial: bool
) -> tuple[list[Observation], bool]:
    """Run one paused request and probe pool availability while it is outbound."""
    barrier = _OutboundBarrier()
    request = asyncio.create_task(
        _request_at_outbound(
            sessions,
            barrier,
            release_before_dial=release_before_dial,
        )
    )
    try:
        await asyncio.wait_for(barrier.entered.wait(), timeout=_TASK_TIMEOUT_SECONDS)
        starved = await _probe_pool(sessions)
    finally:
        barrier.release.set()
        await asyncio.wait_for(request, timeout=_TASK_TIMEOUT_SECONDS)
    return barrier.observations, starved


@pytest.mark.asyncio
async def test_observed_hold_starves_a_pool_and_observed_release_does_not(tmp_path: Path) -> None:
    """Tie the observer property to checkout failure, then calibrate its safe twin."""
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'pressure.db'}",
        pool_size=1,
        max_overflow=0,
        pool_timeout=_POOL_TIMEOUT_SECONDS,
    )
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        held_observations, held_starved = await _run_pressure_case(
            sessions, release_before_dial=False
        )
        with pytest.raises(ConnectionHeldAcrossOutboundCallError):
            assert_dialled_off_the_pool(held_observations, what="the calibrated outbound call")
        assert held_starved is True

        clear_observations, clear_starved = await _run_pressure_case(
            sessions, release_before_dial=True
        )
        assert_dialled_off_the_pool(clear_observations, what="the calibrated outbound call")
        assert clear_starved is False
    finally:
        await engine.dispose()
