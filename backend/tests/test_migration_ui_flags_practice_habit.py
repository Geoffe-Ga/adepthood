"""Round trip for the ``useruiflags.practice_session_habit_id`` migration.

The practice-screen twin of ``test_migration_ui_flags_writing_habit.py``, kept
apart for the same reason: it only needs a minimal ``user`` / ``habit`` /
``useruiflags`` schema (now carrying the writing link) at its parent revision.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Connection, create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

# The chain head this migration was written against, and the migration itself.
_BASE_REVISION = "c4e6a8b0d2f1"  # pragma: allowlist secret
_REVISION = "f2c7d9e1a3b5"  # pragma: allowlist secret

_TABLE = "useruiflags"
_COLUMN = "practice_session_habit_id"
_INDEX = "ix_useruiflags_practice_session_habit_id"

# Written out rather than interpolated: the table and column are fixed, and a
# literal statement is one a reader can check against the migration by eye.
_LINK_HABIT_SEVEN = text("UPDATE useruiflags SET practice_session_habit_id = 7 WHERE user_id = 1")


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


def _bootstrap(db_url: str) -> None:
    """Create the three tables this migration touches, as they stand at the parent.

    One user owns one habit and already has a flags row with the welcome flag
    set, so the round trip can prove an existing row survives both directions.
    """
    with _connect(db_url) as conn:
        conn.execute(text("CREATE TABLE user (id INTEGER PRIMARY KEY, email VARCHAR(254))"))
        conn.execute(
            text(
                "CREATE TABLE habit (id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL REFERENCES user (id))"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE useruiflags (id INTEGER PRIMARY KEY,"
                " has_seen_welcome BOOLEAN NOT NULL DEFAULT 0,"
                " energy_scaffolding_archived BOOLEAN NOT NULL DEFAULT 0,"
                " writing_session_habit_id INTEGER REFERENCES habit (id) ON DELETE SET NULL,"
                " user_id INTEGER NOT NULL UNIQUE REFERENCES user (id) ON DELETE CASCADE)"
            )
        )
        conn.execute(text("INSERT INTO user (id, email) VALUES (1, 'writer@example.com')"))
        conn.execute(text("INSERT INTO habit (id, user_id) VALUES (7, 1)"))
        conn.execute(text("INSERT INTO useruiflags (user_id, has_seen_welcome) VALUES (1, 1)"))


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """A SQLite database stamped at this migration's parent revision."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'ui_flags_practice_habit.sqlite'}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    _bootstrap(async_url)
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


def _flags_row(db_url: str) -> dict[str, Any]:
    with _connect(db_url) as conn:
        row = conn.execute(text("SELECT * FROM useruiflags WHERE user_id = 1")).mappings().one()
        return dict(row)


def test_upgrade_adds_a_nullable_link_and_keeps_the_existing_row(
    migration_config: Config,
) -> None:
    """The column lands nullable, unset on the existing row, which keeps its flags."""
    command.upgrade(migration_config, _REVISION)

    engine = create_engine(_url(migration_config).replace("+aiosqlite", ""))
    try:
        columns = {c["name"]: c for c in inspect(engine).get_columns(_TABLE)}
        indexes = {i["name"] for i in inspect(engine).get_indexes(_TABLE)}
        fks = inspect(engine).get_foreign_keys(_TABLE)
    finally:
        engine.dispose()
    assert columns[_COLUMN]["nullable"] is True
    assert _INDEX in indexes
    link_fks = [fk for fk in fks if fk["constrained_columns"] == [_COLUMN]]
    assert len(link_fks) == 1
    assert link_fks[0]["referred_table"] == "habit"
    assert link_fks[0]["options"].get("ondelete") == "SET NULL"

    row = _flags_row(_url(migration_config))
    assert row[_COLUMN] is None
    assert bool(row["has_seen_welcome"]) is True


def test_deleting_the_linked_habit_nulls_the_migrated_column(migration_config: Config) -> None:
    """With foreign keys enforced, the migrated FK unlinks rather than blocks or cascades."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    with _connect(db_url) as conn:
        conn.execute(_LINK_HABIT_SEVEN)

    with _connect(db_url, foreign_keys=True) as conn:
        conn.execute(text("DELETE FROM habit WHERE id = 7"))

    row = _flags_row(db_url)
    assert row[_COLUMN] is None
    assert bool(row["has_seen_welcome"]) is True


def test_downgrade_drops_the_link_and_re_upgrade_restores_it(migration_config: Config) -> None:
    """Down removes only the column; the row and its unique user survive; up again is clean."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    with _connect(db_url) as conn:
        conn.execute(_LINK_HABIT_SEVEN)

    command.downgrade(migration_config, _BASE_REVISION)

    row = _flags_row(db_url)
    assert _COLUMN not in row
    assert bool(row["has_seen_welcome"]) is True
    with pytest.raises(IntegrityError, match="UNIQUE"), _connect(db_url) as conn:
        conn.execute(text("INSERT INTO useruiflags (user_id) VALUES (1)"))

    command.upgrade(migration_config, _REVISION)
    assert _flags_row(db_url)[_COLUMN] is None
