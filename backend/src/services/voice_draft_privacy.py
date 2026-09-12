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

The privacy/transport decision is recorded in
``docs/adr/0004-creek-vault-http-application-boundary.md``.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from weakref import WeakValueDictionary

from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncConnection,
    AsyncEngine,
    AsyncSession,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

# The two-int PostgreSQL advisory-lock form gives this subsystem its own key
# namespace while the entry id remains directly inspectable in ``pg_locks``.
_VOICE_DRAFT_LOCK_NAMESPACE = 0x56445246
_LOCK_SQL = text("SELECT pg_advisory_lock(:namespace, :entry_id)")
_UNLOCK_SQL = text("SELECT pg_advisory_unlock(:namespace, :entry_id)")


def _async_engine_for(session: AsyncSession) -> AsyncEngine:
    """Return the async engine backing ``session``, failing closed if absent."""
    bind = session.bind
    if isinstance(bind, AsyncEngine):
        return bind
    if isinstance(bind, AsyncConnection):
        return bind.engine
    raise RuntimeError("voice draft privacy serialization requires an async database bind")


class VoiceDraftPrivacySerializer:
    """Coordinate one entry's Creek writes and privacy/lifecycle transitions.

    The historical class name remains public for test and import compatibility;
    the singleton's journal-wide alias below states its expanded responsibility.
    """

    def __init__(self) -> None:
        """Start with no retained per-entry locks."""
        self._local_locks: WeakValueDictionary[int, asyncio.Lock] = WeakValueDictionary()

    def _local_lock_for(self, entry_id: int) -> asyncio.Lock:
        """Return one live lock per entry without retaining idle entry ids."""
        lock = self._local_locks.get(entry_id)
        if lock is None:
            # There is no await between the lookup and store, so one event loop
            # cannot create two locks for the same entry. Held locks and waiters
            # keep strong references; idle locks disappear automatically.
            lock = asyncio.Lock()
            self._local_locks[entry_id] = lock
        return lock

    @asynccontextmanager
    async def _postgres_lock(self, session: AsyncSession, entry_id: int) -> AsyncIterator[None]:
        """Hold a cross-worker lock on a connection outside the application pool."""
        engine = _async_engine_for(session)
        if engine.dialect.name != "postgresql":
            yield
            return

        parameters = {
            "namespace": _VOICE_DRAFT_LOCK_NAMESPACE,
            "entry_id": entry_id,
        }
        # A fresh NullPool engine makes the separation structural: waiting for
        # or holding this advisory lock cannot consume one of the application's
        # finite request connections and deadlock a handler that still needs DB
        # work inside the critical section.
        lock_engine = create_async_engine(engine.url, poolclass=NullPool)
        try:
            async with lock_engine.connect() as connection:
                await connection.execute(_LOCK_SQL, parameters)
                await connection.commit()
                try:
                    yield
                finally:
                    await connection.execute(_UNLOCK_SQL, parameters)
                    await connection.commit()
        finally:
            await lock_engine.dispose()

    @asynccontextmanager
    async def hold(self, session: AsyncSession, entry_id: int) -> AsyncIterator[None]:
        """Order mirrors and privacy PATCHes for ``entry_id`` across all workers."""
        async with self._local_lock_for(entry_id), self._postgres_lock(session, entry_id):
            yield


voice_draft_privacy = VoiceDraftPrivacySerializer()

# All journal Creek mutations share the same lock table and PostgreSQL advisory
# namespace. An alias, not a second instance: two serializers would provide two
# mutually unaware locks and reopen the exact upsert/withdraw race this boundary
# exists to close.
journal_vault_mutations = voice_draft_privacy
