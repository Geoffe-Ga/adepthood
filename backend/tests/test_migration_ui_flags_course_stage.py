"""Round trip for the course reading position migration (#3146).

Kept in its own module rather than appended to ``test_migrations.py``: that file
is where every concurrent migration lane writes, and this one only needs a
minimal ``user`` / ``habit`` / ``useruiflags`` schema at its parent revision.
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

# The chain head this migration was written against, and the migration itself.
_BASE_REVISION = "b3d5f7a9c1e2"  # pragma: allowlist secret
_REVISION = "b6d8f0a2c4e6"  # pragma: allowlist secret

_TABLE = "useruiflags"
_COLUMN = "course_last_stage"


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
                " user_id INTEGER NOT NULL UNIQUE REFERENCES user (id) ON DELETE CASCADE)"
            )
        )
        conn.execute(text("INSERT INTO user (id, email) VALUES (1, 'writer@example.com')"))
        conn.execute(text("INSERT INTO habit (id, user_id) VALUES (7, 1)"))
        conn.execute(text("INSERT INTO useruiflags (user_id, has_seen_welcome) VALUES (1, 1)"))


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """A SQLite database stamped at this migration's parent revision."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'ui_flags_course_stage.sqlite'}"
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


def test_course_reading_position_migration_round_trip(migration_config: Config) -> None:
    """Existing rows retain their flags through upgrade, downgrade and upgrade."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    assert _flags_row(db_url)[_COLUMN] is None
    with _connect(db_url) as conn:
        columns = {column["name"]: column for column in inspect(conn).get_columns(_TABLE)}
        assert columns[_COLUMN]["nullable"] is True
        conn.execute(text("UPDATE useruiflags SET course_last_stage = 5 WHERE user_id = 1"))
    assert _flags_row(db_url)[_COLUMN] == 5
    command.downgrade(migration_config, _BASE_REVISION)
    row = _flags_row(db_url)
    assert _COLUMN not in row
    assert bool(row["has_seen_welcome"]) is True
    command.upgrade(migration_config, _REVISION)
    assert _flags_row(db_url)[_COLUMN] is None
