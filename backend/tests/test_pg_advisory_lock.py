"""Postgres-backed regression for the ``pg_advisory_xact_lock`` lockout path.

Issue #274: the cross-worker half of BUG-AUTH-007 lives in
``routers.auth._acquire_email_lock_pg``.  The single-process lockout
regression in ``test_auth.py`` runs on SQLite, where that function is an
intentional no-op — so the dialect detection, the SHA-256 → int8 key
packing, and the actual advisory-lock serialization had no automated
coverage.  The derivation and short-circuit tests below run everywhere;
the live-lock tests run only when ``TEST_POSTGRES_URL`` points at a real
Postgres (CI provides one via the ``migration-drift`` job's service).
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
from typing import TYPE_CHECKING

import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine

from conftest import test_engine
from routers.auth import (
    _ADVISORY_LOCK_KEY_BYTES,
    _acquire_email_lock_pg,
    _advisory_lock_key,
)
from services.voice_draft_privacy import VoiceDraftPrivacySerializer

if TYPE_CHECKING:
    from collections.abc import Iterator

_INT8_MIN = -(2**63)
_INT8_MAX = 2**63 - 1

_PG_URL_ENV = "TEST_POSTGRES_URL"

_LOCK_ACQUIRE_TIMEOUT_SECONDS = 5.0
# Long enough that a genuinely-blocked acquire cannot sneak through on a
# slow CI runner; short enough not to drag the suite.
_LOCK_HOLD_PROBE_SECONDS = 0.5


# ── Key derivation (runs everywhere) ────────────────────────────────────


def test_advisory_lock_key_pins_sha256_int8_packing() -> None:
    """The key is the first 8 SHA-256 bytes packed big-endian signed.

    Pinned against an independent computation so mutating the truncation
    width or the signedness (either of which would break int8 packing or
    silently re-key every email's lock) fails here rather than as a
    production Postgres error.
    """
    email = "pin@example.com"
    expected = int.from_bytes(hashlib.sha256(email.encode()).digest()[:8], "big", signed=True)
    assert _advisory_lock_key(email) == expected
    assert _ADVISORY_LOCK_KEY_BYTES == 8


def test_advisory_lock_key_always_fits_int8() -> None:
    """Every derived key must fit ``pg_advisory_xact_lock(bigint)``."""
    for i in range(1_000):
        key = _advisory_lock_key(f"user-{i}@example.com")
        assert _INT8_MIN <= key <= _INT8_MAX


def test_advisory_lock_key_distinct_for_distinct_emails() -> None:
    """Sanity: different emails get different keys (collision ≈ 2^-64)."""
    assert _advisory_lock_key("a@example.com") != _advisory_lock_key("b@example.com")


# ── Dialect short-circuit (runs everywhere, SQLite-backed) ──────────────


class _StatementRecorder:
    """Collects every SQL statement crossing the engine."""

    def __init__(self) -> None:
        self.statements: list[str] = []

    def __call__(
        self,
        _conn: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        """SQLAlchemy ``before_cursor_execute`` hook."""
        self.statements.append(statement)


@pytest.fixture
def sql_recorder() -> Iterator[_StatementRecorder]:
    """Attach a statement recorder to the SQLite test engine for one test."""
    recorder = _StatementRecorder()
    sync_engine = test_engine.sync_engine
    event.listen(sync_engine, "before_cursor_execute", recorder)
    yield recorder
    event.remove(sync_engine, "before_cursor_execute", recorder)


@pytest.mark.asyncio
async def test_sqlite_dialect_short_circuits_without_sql(
    db_session: AsyncSession, sql_recorder: _StatementRecorder
) -> None:
    """On SQLite the acquire is a clean no-op — no SQL, no error.

    Pins the dialect-detection branch: tests and local dev run without
    advisory locks, relying on the in-process asyncio lock alone.
    """
    await _acquire_email_lock_pg(db_session, "sqlite-noop@example.com")

    advisory_calls = [s for s in sql_recorder.statements if re.search(r"pg_advisory", s)]
    assert advisory_calls == []


@pytest.mark.asyncio
async def test_voice_draft_serializer_uses_only_its_local_lock_on_sqlite(
    db_session: AsyncSession, sql_recorder: _StatementRecorder
) -> None:
    """SQLite needs no advisory SQL and the request session stays transaction-free."""
    serializer = VoiceDraftPrivacySerializer()

    async with serializer.hold(db_session, 17):
        assert not db_session.in_transaction()

    advisory_calls = [s for s in sql_recorder.statements if re.search(r"pg_advisory", s)]
    assert advisory_calls == []


# ── Live Postgres serialization (gated on TEST_POSTGRES_URL) ────────────


@pytest.fixture
def pg_url() -> str:
    """The Postgres URL for live-lock tests, or skip when not provisioned."""
    url = os.getenv(_PG_URL_ENV)
    if not url:
        pytest.skip(f"{_PG_URL_ENV} not set — live advisory-lock tests need Postgres")
    return url


async def _open_pg_session(url: str) -> tuple[AsyncSession, AsyncEngine]:
    """Create an engine + session pair; caller owns both lifetimes."""
    engine = create_async_engine(url)
    return AsyncSession(bind=engine), engine


@pytest.mark.asyncio
async def test_pg_advisory_lock_serializes_same_email(pg_url: str) -> None:
    """Two sessions contend on one email: the second blocks until commit.

    This is the cross-worker guarantee the SQLite suite cannot exercise —
    ``pg_advisory_xact_lock`` is transaction-scoped, so the second
    worker's lockout check cannot begin until the first worker's
    check + record transaction has committed (BUG-AUTH-007).
    """
    email = "pg-race@example.com"
    s1, e1 = await _open_pg_session(pg_url)
    s2, e2 = await _open_pg_session(pg_url)
    try:
        await _acquire_email_lock_pg(s1, email)

        contender = asyncio.create_task(_acquire_email_lock_pg(s2, email))
        done, _pending = await asyncio.wait({contender}, timeout=_LOCK_HOLD_PROBE_SECONDS)
        # While session 1's transaction is open, the contender must block.
        assert not done, "second acquire completed while the first held the lock"

        # Releasing the first transaction lets the contender through.
        await s1.commit()
        await asyncio.wait_for(contender, timeout=_LOCK_ACQUIRE_TIMEOUT_SECONDS)
        await s2.commit()
    finally:
        await s1.close()
        await s2.close()
        await e1.dispose()
        await e2.dispose()


@pytest.mark.asyncio
async def test_pg_advisory_lock_distinct_emails_do_not_contend(pg_url: str) -> None:
    """Different emails derive different keys and must not serialize."""
    s1, e1 = await _open_pg_session(pg_url)
    s2, e2 = await _open_pg_session(pg_url)
    try:
        await _acquire_email_lock_pg(s1, "first@example.com")
        # A distinct email's acquire completes immediately even while the
        # first session's transaction is still open.
        await asyncio.wait_for(
            _acquire_email_lock_pg(s2, "second@example.com"),
            timeout=_LOCK_ACQUIRE_TIMEOUT_SECONDS,
        )
        await s1.commit()
        await s2.commit()
    finally:
        await s1.close()
        await s2.close()
        await e1.dispose()
        await e2.dispose()


@pytest.mark.asyncio
async def test_pg_voice_draft_serializers_order_the_same_entry_across_workers(pg_url: str) -> None:
    """Independent worker-local serializers still contend on one Postgres key."""
    first = VoiceDraftPrivacySerializer()
    second = VoiceDraftPrivacySerializer()
    s1, e1 = await _open_pg_session(pg_url)
    s2, e2 = await _open_pg_session(pg_url)
    first_entered = asyncio.Event()
    release_first = asyncio.Event()
    second_entered = asyncio.Event()

    async def _hold_first() -> None:
        async with first.hold(s1, 42):
            assert not s1.in_transaction(), "the lock borrowed the request session"
            first_entered.set()
            await release_first.wait()
            await s1.commit()

    async def _hold_second() -> None:
        async with second.hold(s2, 42):
            assert not s2.in_transaction(), "the lock borrowed the request session"
            second_entered.set()
            await s2.commit()

    holder = asyncio.create_task(_hold_first())
    try:
        await asyncio.wait_for(first_entered.wait(), timeout=_LOCK_ACQUIRE_TIMEOUT_SECONDS)
        contender = asyncio.create_task(_hold_second())
        done, _pending = await asyncio.wait({contender}, timeout=_LOCK_HOLD_PROBE_SECONDS)
        assert not done, "a second worker entered while the first held the entry lock"
        assert not second_entered.is_set()

        release_first.set()
        await asyncio.wait_for(holder, timeout=_LOCK_ACQUIRE_TIMEOUT_SECONDS)
        await asyncio.wait_for(contender, timeout=_LOCK_ACQUIRE_TIMEOUT_SECONDS)
        assert second_entered.is_set()
    finally:
        release_first.set()
        if not holder.done():
            await holder
        await s1.close()
        await s2.close()
        await e1.dispose()
        await e2.dispose()


@pytest.mark.asyncio
async def test_pg_voice_draft_serializers_do_not_contend_across_entries(pg_url: str) -> None:
    """The serializer scopes contention to one journal entry, not the whole fleet."""
    first = VoiceDraftPrivacySerializer()
    second = VoiceDraftPrivacySerializer()
    s1, e1 = await _open_pg_session(pg_url)
    s2, e2 = await _open_pg_session(pg_url)
    try:
        async with first.hold(s1, 100):
            await asyncio.wait_for(
                _enter_voice_draft_lock(second, s2, 101),
                timeout=_LOCK_ACQUIRE_TIMEOUT_SECONDS,
            )
    finally:
        await s1.close()
        await s2.close()
        await e1.dispose()
        await e2.dispose()


async def _enter_voice_draft_lock(
    serializer: VoiceDraftPrivacySerializer,
    session: AsyncSession,
    entry_id: int,
) -> None:
    """Enter and immediately release one Voice Draft privacy lock."""
    async with serializer.hold(session, entry_id):
        await session.commit()
