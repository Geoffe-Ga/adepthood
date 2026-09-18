"""Live-PostgreSQL proof that the account barrier orders two separate workers.

The default lane is SQLite, where ``pg_advisory_lock`` does not exist and the
barrier's cross-worker half short-circuits to nothing. Everything the SQLite
suite can show about this barrier is therefore a property of one event loop's
``asyncio.Lock``, and a namespace collision -- two subsystems keyed on the same
first integer, deadlocking on equal second integers -- is invisible there by
construction.

So the cross-worker half is proved here, against the Postgres 16 this package
migrates, using **two independently constructed serializer instances**. Two
instances share no in-process lock table, so any ordering observed below came
from the database and from nowhere else.

The pool assertions are the other half of the claim. Waiting for this lock must
not consume one of the application's finite request connections, or a handler
that still needs database work inside its critical section would deadlock the
pool rather than merely wait.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import QueuePool

from services.advisory_lock_namespaces import (
    ACCOUNT_EGRESS_LOCK_NAMESPACE,
    VOICE_DRAFT_LOCK_NAMESPACE,
)
from services.voice_draft_privacy import VoiceDraftPrivacySerializer

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator

    from sqlalchemy.ext.asyncio import AsyncEngine

pytestmark = pytest.mark.integration

#: Long enough that a contender which *can* proceed will have, short enough that
#: a test which is genuinely blocked does not stall the lane.
_LOCK_HOLD_PROBE_SECONDS = 0.5
_LOCK_ACQUIRE_TIMEOUT_SECONDS = 5.0

_ACCOUNT = 4242
_ANOTHER_ACCOUNT = 4243


@pytest_asyncio.fixture
async def pooled_engine(pg_database_url: str) -> AsyncGenerator[AsyncEngine, None]:
    """An engine with a real pool, so ``checkedout()`` is a meaningful number.

    The package's own ``pg_engine`` uses ``NullPool``, under which the pool
    assertions below would be true of anything.
    """
    engine = create_async_engine(pg_database_url)
    try:
        yield engine
    finally:
        await engine.dispose()


def _checked_out(engine: AsyncEngine) -> int:
    """How many connections the application pool currently has handed out."""
    pool = engine.sync_engine.pool
    assert isinstance(pool, QueuePool), "this assertion needs a counting pool to be meaningful"
    return pool.checkedout()


def _barrier() -> VoiceDraftPrivacySerializer:
    """One freshly constructed account barrier, sharing nothing in process."""
    return VoiceDraftPrivacySerializer(namespace=ACCOUNT_EGRESS_LOCK_NAMESPACE)


async def _hold_until(
    barrier: VoiceDraftPrivacySerializer,
    session: AsyncSession,
    key: int,
    entered: asyncio.Event,
    release: asyncio.Event,
) -> None:
    """Take the barrier, announce it, and keep it until told to let go."""
    async with barrier.hold(session, key):
        assert not session.in_transaction(), (
            "the request session was left in a transaction inside the barrier, "
            "so a pooled connection is held across whatever the caller dials"
        )
        entered.set()
        await release.wait()


async def _take_and_release(
    barrier: VoiceDraftPrivacySerializer, session: AsyncSession, key: int
) -> None:
    """Acquire and immediately release, so a blocked acquire never completes."""
    async with barrier.hold(session, key):
        pass


@pytest.mark.asyncio
async def test_two_barrier_instances_contend_on_one_account(
    pooled_engine: AsyncEngine,
) -> None:
    """A second worker cannot enter while the first holds the same account."""
    entered = asyncio.Event()
    release = asyncio.Event()
    async with (
        AsyncSession(bind=pooled_engine) as first,
        AsyncSession(bind=pooled_engine) as second,
    ):
        holder = asyncio.create_task(_hold_until(_barrier(), first, _ACCOUNT, entered, release))
        try:
            await asyncio.wait_for(entered.wait(), timeout=_LOCK_ACQUIRE_TIMEOUT_SECONDS)
            checked_out = _checked_out(pooled_engine)

            contender = asyncio.create_task(_take_and_release(_barrier(), second, _ACCOUNT))
            done, _pending = await asyncio.wait({contender}, timeout=_LOCK_HOLD_PROBE_SECONDS)

            assert not done, "a second worker entered while the first held the account barrier"
            assert _checked_out(pooled_engine) == checked_out, (
                "waiting for the advisory lock borrowed a connection from the "
                "application pool, which is the deadlock this barrier avoids"
            )
        finally:
            release.set()
        await asyncio.wait_for(holder, timeout=_LOCK_ACQUIRE_TIMEOUT_SECONDS)
        await asyncio.wait_for(contender, timeout=_LOCK_ACQUIRE_TIMEOUT_SECONDS)


@pytest.mark.asyncio
async def test_two_accounts_do_not_contend(pooled_engine: AsyncEngine) -> None:
    """The barrier is per account, not global: a second account walks straight in."""
    entered = asyncio.Event()
    release = asyncio.Event()
    async with (
        AsyncSession(bind=pooled_engine) as first,
        AsyncSession(bind=pooled_engine) as second,
    ):
        holder = asyncio.create_task(_hold_until(_barrier(), first, _ACCOUNT, entered, release))
        try:
            await asyncio.wait_for(entered.wait(), timeout=_LOCK_ACQUIRE_TIMEOUT_SECONDS)

            await asyncio.wait_for(
                _take_and_release(_barrier(), second, _ANOTHER_ACCOUNT),
                timeout=_LOCK_ACQUIRE_TIMEOUT_SECONDS,
            )
        finally:
            release.set()
        await asyncio.wait_for(holder, timeout=_LOCK_ACQUIRE_TIMEOUT_SECONDS)


@pytest.mark.asyncio
async def test_the_entry_serializer_does_not_contend_on_an_equal_key(
    pooled_engine: AsyncEngine,
) -> None:
    """Account 4242 and entry 4242 are two locks in PostgreSQL as well as in process.

    This is the assertion that a namespace collision fails, and the only place it
    can be made honestly: on SQLite no advisory statement is issued, so equal
    namespaces and distinct ones are indistinguishable.
    """
    entered = asyncio.Event()
    release = asyncio.Event()
    entry_serializer = VoiceDraftPrivacySerializer(namespace=VOICE_DRAFT_LOCK_NAMESPACE)
    async with (
        AsyncSession(bind=pooled_engine) as first,
        AsyncSession(bind=pooled_engine) as second,
    ):
        holder = asyncio.create_task(_hold_until(_barrier(), first, _ACCOUNT, entered, release))
        try:
            await asyncio.wait_for(entered.wait(), timeout=_LOCK_ACQUIRE_TIMEOUT_SECONDS)

            await asyncio.wait_for(
                _take_and_release(entry_serializer, second, _ACCOUNT),
                timeout=_LOCK_ACQUIRE_TIMEOUT_SECONDS,
            )
        finally:
            release.set()
        await asyncio.wait_for(holder, timeout=_LOCK_ACQUIRE_TIMEOUT_SECONDS)
