"""Round trip for the ``generationslot`` lease migration (#623).

Kept in its own module, like the other single-migration round trips, so it
needs only a minimal ``user`` table at its parent revision.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

_BASE_REVISION = "e7a3c5f1d902"  # pragma: allowlist secret
_REVISION = "a1c3e5f7b9d2"  # pragma: allowlist secret
_TABLE = "generationslot"
_INSERT_SLOT_ZERO = text(
    "INSERT INTO generationslot (user_id, slot, acquired_at, expires_at)"
    " VALUES (1, 0, '2026-10-01T00:00:00+00:00', '2026-10-01T00:05:00+00:00')"
)


@contextmanager
def _connect(db_url: str, *, foreign_keys: bool = False) -> Iterator[Connection]:
    """A committing sync connection to ``db_url``, optionally enforcing foreign keys."""
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        with engine.begin() as conn:
            if foreign_keys:
                conn.execute(text("PRAGMA foreign_keys = ON"))
            yield conn
    finally:
        engine.dispose()


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """A SQLite database with one user, stamped at this migration's parent."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'generation_slot.sqlite'}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    with _connect(async_url) as conn:
        conn.execute(text("CREATE TABLE user (id INTEGER PRIMARY KEY, email VARCHAR(254))"))
        conn.execute(text("INSERT INTO user (id, email) VALUES (1, 'writer@example.com')"))
    cfg = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    cfg.config_file_name = None
    cfg.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", async_url)
    command.stamp(cfg, _BASE_REVISION)
    return cfg


def _url(cfg: Config) -> str:
    url = cfg.get_main_option("sqlalchemy.url")
    assert url is not None
    return url


def test_the_lease_migration_chains_from_the_previous_head(migration_config: Config) -> None:
    """One linear chain: this revision sits directly on the head it was written against."""
    script = ScriptDirectory.from_config(migration_config)
    revision = script.get_revision(_REVISION)
    assert revision is not None
    assert revision.down_revision == _BASE_REVISION


def test_upgrade_creates_the_lease_with_a_unique_slot_per_user(migration_config: Config) -> None:
    """The third concurrent generation is refused by this constraint, on any worker."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)

    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        columns = {c["name"]: c for c in inspect(engine).get_columns(_TABLE)}
        indexes = {i["name"] for i in inspect(engine).get_indexes(_TABLE)}
        fks = inspect(engine).get_foreign_keys(_TABLE)
    finally:
        engine.dispose()
    assert set(columns) == {"id", "user_id", "slot", "acquired_at", "expires_at"}
    assert not any(c["nullable"] for name, c in columns.items() if name != "id")
    assert "ix_generationslot_user_id" in indexes
    assert [fk["options"].get("ondelete") for fk in fks] == ["CASCADE"]

    with _connect(db_url) as conn:
        conn.execute(_INSERT_SLOT_ZERO)
    with pytest.raises(IntegrityError, match="UNIQUE"), _connect(db_url) as conn:
        conn.execute(_INSERT_SLOT_ZERO)


def test_deleting_the_user_drops_their_leases(migration_config: Config) -> None:
    """A lease never outlives its account."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    with _connect(db_url) as conn:
        conn.execute(_INSERT_SLOT_ZERO)

    with _connect(db_url, foreign_keys=True) as conn:
        conn.execute(text("DELETE FROM user WHERE id = 1"))
        remaining = conn.execute(text("SELECT COUNT(*) FROM generationslot")).scalar_one()

    assert remaining == 0


def test_downgrade_drops_the_lease_and_re_upgrade_restores_it(migration_config: Config) -> None:
    """Down removes the table (leases are transient); up again is clean."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    with _connect(db_url) as conn:
        conn.execute(_INSERT_SLOT_ZERO)

    command.downgrade(migration_config, _BASE_REVISION)
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        assert _TABLE not in inspect(engine).get_table_names()
    finally:
        engine.dispose()

    command.upgrade(migration_config, _REVISION)
    with _connect(db_url) as conn:
        conn.execute(_INSERT_SLOT_ZERO)
