"""Round trip for the ``llmusagelog`` generation-key migration (#623 PR3).

Record §2 asks to alert "if p95 provider cost approaches 3.5¢ per charged
generation". One usage row is one provider call, so pricing a generation needs
two additive, nullable columns: ``generation_id`` groups a generation's calls
and ``charged`` marks the server-paid ones. A pre-existing row keeps ``NULL``
in both, which the metric reads as "before PR3" and excludes.
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

_BASE_REVISION = "a1c3e5f7b9d2"  # pragma: allowlist secret
_REVISION = "c4e6a8b0d2f1"  # pragma: allowlist secret
_TABLE = "llmusagelog"
_INDEX = "ix_llmusagelog_generation_id"
_INSERT_LEGACY_ROW = text(
    "INSERT INTO llmusagelog (user_id, timestamp, provider, model, prompt_tokens,"
    " completion_tokens, total_tokens, estimated_cost_usd)"
    " VALUES (1, '2026-09-01T00:00:00+00:00', 'openai', 'gpt-4o-mini', 10, 5, 15, 0.000005)"
)


@contextmanager
def _connect(db_url: str) -> Iterator[Connection]:
    """A committing sync connection to ``db_url``."""
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        with engine.begin() as conn:
            yield conn
    finally:
        engine.dispose()


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """A SQLite database holding one legacy usage row, stamped at the parent revision."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'generation_key.sqlite'}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    with _connect(async_url) as conn:
        conn.execute(text("CREATE TABLE user (id INTEGER PRIMARY KEY, email VARCHAR(254))"))
        conn.execute(text("INSERT INTO user (id, email) VALUES (1, 'writer@example.com')"))
        conn.execute(
            text(
                "CREATE TABLE llmusagelog (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,"
                " timestamp DATETIME NOT NULL, provider VARCHAR(32) NOT NULL,"
                " model VARCHAR(128) NOT NULL, prompt_tokens INTEGER NOT NULL,"
                " completion_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL,"
                " estimated_cost_usd NUMERIC(12, 6), journal_entry_id INTEGER)"
            )
        )
        conn.execute(_INSERT_LEGACY_ROW)
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


def test_the_generation_key_migration_chains_from_the_lease_head(
    migration_config: Config,
) -> None:
    """One linear chain: this revision sits directly on the head it was written against."""
    script = ScriptDirectory.from_config(migration_config)
    revision = script.get_revision(_REVISION)
    assert revision is not None
    assert revision.down_revision == _BASE_REVISION
    assert script.get_heads() == [_REVISION]


def test_upgrade_adds_two_nullable_columns_and_keeps_legacy_rows_null(
    migration_config: Config,
) -> None:
    """Additive only: a pre-PR3 row survives with NULL in both new columns."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        columns = {c["name"]: c for c in inspect(engine).get_columns(_TABLE)}
        indexes = {i["name"]: i for i in inspect(engine).get_indexes(_TABLE)}
    finally:
        engine.dispose()
    assert columns["generation_id"]["nullable"] is True
    assert columns["charged"]["nullable"] is True
    assert indexes[_INDEX]["column_names"] == ["generation_id"]

    with _connect(db_url) as conn:
        legacy = conn.execute(text("SELECT generation_id, charged, model FROM llmusagelog")).one()
    assert tuple(legacy) == (None, None, "gpt-4o-mini")


def test_downgrade_drops_both_columns_and_keeps_the_rows(migration_config: Config) -> None:
    """Down removes the columns and their index; the usage rows themselves stay."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    with _connect(db_url) as conn:
        conn.execute(
            text("UPDATE llmusagelog SET generation_id = :gid, charged = 1"),
            {"gid": "a" * 32},
        )

    command.downgrade(migration_config, _BASE_REVISION)

    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        columns = {c["name"] for c in inspect(engine).get_columns(_TABLE)}
        indexes = {i["name"] for i in inspect(engine).get_indexes(_TABLE)}
    finally:
        engine.dispose()
    assert "generation_id" not in columns
    assert "charged" not in columns
    assert _INDEX not in indexes
    with _connect(db_url) as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM llmusagelog")).scalar_one() == 1
