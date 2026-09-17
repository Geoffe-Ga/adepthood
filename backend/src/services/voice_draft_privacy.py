"""Serialize every Creek mutation against entry privacy/lifecycle changes.

The journal database and Creek cannot participate in one transaction. Journal
upserts, Voice Draft mirrors, privacy upgrades, and deletion must therefore
agree on one per-entry ordering: a writer finishes first and the later privacy
operation retracts it, or the privacy operation finishes first and a later
writer observes the now-intimate/deleted row and skips egress.

One weakly-held asyncio lock closes the race inside a worker without retaining an
unbounded key set. PostgreSQL deployments add a session advisory lock on a
dedicated ``NullPool`` connection, which provides the same ordering across
workers without borrowing from the application pool. The request session can
therefore remain committed during Creek I/O. SQLite is used only by the
single-process test/development lane, where the local lock is the complete
coordination boundary.

The mechanism here is keyed on a *namespace* and an integer, and the entry id is
only what this module's own instance puts in the second slot.
:mod:`services.account_egress_barrier` constructs a second instance under its own
namespace to order whole-account egress the same way; see
:func:`VoiceDraftPrivacySerializer.__init__` for why two namespaces never
collide on equal integers.

The privacy/transport decision is recorded in
``docs/adr/0004-creek-vault-http-application-boundary.md``.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from typing import Final, Literal
from weakref import WeakValueDictionary

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import (
    AsyncConnection,
    AsyncEngine,
    AsyncSession,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

from errors import service_unavailable
from services.advisory_lock_namespaces import VOICE_DRAFT_LOCK_NAMESPACE

_LOGGER = logging.getLogger(__name__)

# The two-int PostgreSQL advisory-lock form gives this subsystem its own key
# namespace while the caller's key remains directly inspectable in ``pg_locks``.
# The constant itself lives in ``services.advisory_lock_namespaces``, with every
# other one, so a collision between two subsystems is assertable.
_LOCK_SQL = text("SELECT pg_advisory_lock(:namespace, :key)")
_UNLOCK_SQL = text("SELECT pg_advisory_unlock(:namespace, :key)")

#: What a caller wants done when the cross-worker half cannot be established at
#: all -- a lock connection that will not open. ``refuse`` is the answer for a
#: region that is about to hand content outward: no ordering means no egress.
#: ``proceed`` is the answer for a region that only ever *reduces* exposure, and
#: erasure is the only such caller: blocking somebody's deletion because a lock
#: connection failed would be the ordering mechanism causing the harm it exists
#: to prevent.
OnUnavailable = Literal["refuse", "proceed"]

#: The one client-visible token this boundary can produce. A caller that sees it
#: has had nothing sent on its behalf.
EGRESS_ORDERING_UNAVAILABLE: Final[str] = "egress_ordering_unavailable"


def _async_engine_for(session: AsyncSession) -> AsyncEngine:
    """Return the async engine backing ``session``, failing closed if absent."""
    bind = session.bind
    if isinstance(bind, AsyncEngine):
        return bind
    if isinstance(bind, AsyncConnection):
        return bind.engine
    raise RuntimeError("voice draft privacy serialization requires an async database bind")


async def _locked_connection(
    lock_engine: AsyncEngine, parameters: Mapping[str, int]
) -> AsyncConnection:
    """Open one dedicated connection and take the advisory lock on it.

    The connection is closed here if the lock statement itself fails, so a
    caller that catches the error never has to reason about a half-opened
    connection it was not handed.
    """
    connection = await lock_engine.connect()
    try:
        await connection.execute(_LOCK_SQL, dict(parameters))
        await connection.commit()
    except SQLAlchemyError:
        await connection.close()
        raise
    return connection


async def _release(
    connection: AsyncConnection,
    lock_engine: AsyncEngine,
    parameters: Mapping[str, int],
) -> None:
    """Give the advisory lock and its dedicated connection back, in that order."""
    try:
        await connection.execute(_UNLOCK_SQL, dict(parameters))
        await connection.commit()
    finally:
        await connection.close()
        await lock_engine.dispose()


def _answer_unavailable(on_unavailable: OnUnavailable) -> None:
    """Refuse the caller, or let it proceed unordered, on a failed acquire.

    The asymmetry is the point and it is not a fallback policy knob: an egress
    caller must not transmit without an ordering guarantee, and an erasure
    caller must not be blocked by one.
    """
    if on_unavailable == "refuse":
        _LOGGER.warning("advisory lock connection failed; refusing to egress unordered")
        raise service_unavailable(EGRESS_ORDERING_UNAVAILABLE)
    _LOGGER.warning("advisory lock connection failed; proceeding unordered")


class VoiceDraftPrivacySerializer:
    """Coordinate one key's Creek writes and privacy/lifecycle transitions.

    The key is a caller-chosen integer whose *meaning* is fixed by the
    namespace this instance was constructed with: this module's own singleton
    puts a journal entry id there, and
    :mod:`services.account_egress_barrier` puts an account id there. Two
    instances under different namespaces are two independent ordering domains
    that never collide on equal integers -- neither in PostgreSQL, where the
    namespace is the advisory lock's first key, nor in process, where each
    instance owns its own lock table.

    The historical class name remains public for test and import compatibility;
    the singleton's journal-wide alias below states its expanded responsibility.
    """

    def __init__(self, namespace: int = VOICE_DRAFT_LOCK_NAMESPACE) -> None:
        """Start with no retained per-key locks under ``namespace``."""
        self._namespace = namespace
        self._local_locks: WeakValueDictionary[int, asyncio.Lock] = WeakValueDictionary()

    @property
    def namespace(self) -> int:
        """The PostgreSQL advisory-lock namespace this instance orders under."""
        return self._namespace

    def _local_lock_for(self, key: int) -> asyncio.Lock:
        """Return one live lock per key without retaining idle keys."""
        lock = self._local_locks.get(key)
        if lock is None:
            # There is no await between the lookup and store, so one event loop
            # cannot create two locks for the same key. Held locks and waiters
            # keep strong references; idle locks disappear automatically.
            lock = asyncio.Lock()
            self._local_locks[key] = lock
        return lock

    @asynccontextmanager
    async def _postgres_lock(
        self,
        session: AsyncSession,
        key: int,
        on_unavailable: OnUnavailable,
    ) -> AsyncIterator[None]:
        """Hold a cross-worker lock on a connection outside the application pool.

        The acquire is the only translated failure point, and the ``try`` below
        is drawn around it alone for that reason. Nothing raised inside the
        critical section is caught here, so a caller's own failure -- including
        its own ``SQLAlchemyError`` -- stays the caller's own failure and is
        never reported as an unavailable barrier.
        """
        engine = _async_engine_for(session)
        if engine.dialect.name != "postgresql":
            yield
            return

        parameters = {"namespace": self._namespace, "key": key}
        # A fresh NullPool engine makes the separation structural: waiting for
        # or holding this advisory lock cannot consume one of the application's
        # finite request connections and deadlock a handler that still needs DB
        # work inside the critical section.
        lock_engine = create_async_engine(engine.url, poolclass=NullPool)
        try:
            connection = await _locked_connection(lock_engine, parameters)
        except SQLAlchemyError:
            await lock_engine.dispose()
            _answer_unavailable(on_unavailable)
            yield
            return
        try:
            yield
        finally:
            await _release(connection, lock_engine, parameters)

    @asynccontextmanager
    async def hold(
        self,
        session: AsyncSession,
        key: int,
        *,
        on_unavailable: OnUnavailable = "refuse",
        cross_worker: bool = True,
    ) -> AsyncIterator[None]:
        """Order this namespace's critical sections for ``key`` across all workers.

        ``cross_worker=False`` suppresses the advisory statements and nothing
        else: the in-process lock is taken either way, so the ordering property
        inside a worker survives every setting an operator can reach. It exists
        for a rolling deploy whose older workers do not take this lock at all,
        where cross-worker ordering is unobtainable rather than merely switched
        off -- see :class:`services.account_egress_barrier.EgressBarrierRollout`.
        """
        async with self._local_lock_for(key):
            if not cross_worker:
                yield
                return
            async with self._postgres_lock(session, key, on_unavailable):
                yield


voice_draft_privacy = VoiceDraftPrivacySerializer()

# All journal Creek mutations share the same lock table and PostgreSQL advisory
# namespace. An alias, not a second instance: two serializers would provide two
# mutually unaware locks and reopen the exact upsert/withdraw race this boundary
# exists to close.
journal_vault_mutations = voice_draft_privacy
