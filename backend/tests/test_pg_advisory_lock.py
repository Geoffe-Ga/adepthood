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
