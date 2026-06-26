"""Service-level + migration tests for DB-backed practice-session idempotency.

Covers the ``services.practice_session_idempotency`` primitives (hash, check,
atomic insert) and a SQLite round-trip of the migration that adds the backing
``practicesessionspend`` table. The router-level cross-restart / single-session
regression lives in ``test_practice_sessions.py``.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.ext.asyncio import AsyncSession

from services.practice_session_idempotency import (
    hash_idem_key,
    record_session,
    recorded_session_id,
)


class TestHashIdemKey:
    """The column value hashes ``(user_id, raw_key)`` one-way and per-user."""

    def test_is_deterministic_and_user_scoped(self) -> None:
        """Same inputs hash equal; a different user yields a disjoint hash."""
        assert hash_idem_key(1, "k") == hash_idem_key(1, "k")
        assert hash_idem_key(1, "k") != hash_idem_key(2, "k")

    def test_never_contains_the_raw_key(self) -> None:
        """The raw client header never appears in the stored digest."""
        assert "secret-key" not in hash_idem_key(1, "secret-key")


@pytest.mark.asyncio
class TestRecordedSessionId:
    """``recorded_session_id`` reads back the deduplicated session id."""

    async def test_none_for_unseen_key(self, db_session: AsyncSession) -> None:
        """An unrecorded key resolves to ``None``."""
        assert await recorded_session_id(db_session, 1, "unseen") is None

    async def test_none_when_raw_key_is_none(self, db_session: AsyncSession) -> None:
        """A missing header (``None``) short-circuits to ``None``."""
        assert await recorded_session_id(db_session, 1, None) is None

    async def test_returns_recorded_id(self, db_session: AsyncSession) -> None:
        """After recording, the same key resolves to the recorded session id."""
        assert await record_session(db_session, 1, "key-x", 4242) is True
        await db_session.commit()
        assert await recorded_session_id(db_session, 1, "key-x") == 4242


@pytest.mark.asyncio
class TestRecordSession:
    """``record_session`` is an atomic, collision-aware insert."""

    async def test_duplicate_key_collides_without_clobbering(
        self, db_session: AsyncSession
    ) -> None:
        """A second record under the same key returns ``False`` and keeps the winner."""
        assert await record_session(db_session, 1, "dup", 1) is True
        await db_session.commit()
        # Same (user, key) again → UNIQUE collision → False, no second row.
        assert await record_session(db_session, 1, "dup", 2) is False
        await db_session.rollback()
        # The recorded mapping is unchanged — the first writer wins.
        assert await recorded_session_id(db_session, 1, "dup") == 1

    async def test_distinct_key_or_user_does_not_collide(self, db_session: AsyncSession) -> None:
        """Different keys, and the same key under a different user, are independent."""
        assert await record_session(db_session, 1, "a", 10) is True
        assert await record_session(db_session, 1, "b", 11) is True  # different key
        assert await record_session(db_session, 2, "a", 12) is True  # different user
        await db_session.commit()
        assert await recorded_session_id(db_session, 2, "a") == 12


# -- Migration round-trip ---------------------------------------------------

_IDEM_REVISION = "d0e1f2a3b4c5"  # pragma: allowlist secret
_IDEM_BASE_REVISION = "c8d9e0f1a2b3"  # pragma: allowlist secret


def _bootstrap_idem_dependencies(sync_url: str) -> None:
    """Pre-create the ``user`` + ``practicesession`` tables the FKs reference.

    Mirrors ``test_migrations`` style: stamp at the base revision and run only
    this migration, rather than replaying the whole chain on SQLite.
    """
    engine = create_engine(sync_url)
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE user (id INTEGER PRIMARY KEY, email VARCHAR(255))"))
        conn.execute(text("CREATE TABLE practicesession (id INTEGER PRIMARY KEY, user_id INTEGER)"))
    engine.dispose()


def _has_table(sync_url: str, table: str) -> bool:
    """Return whether ``table`` exists in the SQLite database at ``sync_url``."""
    engine = create_engine(sync_url)
    try:
        return inspect(engine).has_table(table)
    finally:
        engine.dispose()


def test_idempotency_migration_round_trips_on_sqlite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Upgrade creates ``practicesessionspend``; downgrade drops it; re-upgrade is clean."""
    db_path = tmp_path / "psidem_round_trip.sqlite"
    sync_url = f"sqlite:///{db_path}"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    _bootstrap_idem_dependencies(sync_url)

    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _IDEM_BASE_REVISION)

    command.upgrade(cfg, _IDEM_REVISION)
    assert _has_table(sync_url, "practicesessionspend")

    command.downgrade(cfg, _IDEM_BASE_REVISION)
    assert not _has_table(sync_url, "practicesessionspend")

    command.upgrade(cfg, _IDEM_REVISION)
    assert _has_table(sync_url, "practicesessionspend")
