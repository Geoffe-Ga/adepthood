"""Round trip for the ``userpractice.habit_id`` migration (#3151).

Kept in its own module rather than appended to ``test_migrations.py``: that file
is where every concurrent migration lane writes, and this one only needs a
minimal ``user`` / ``habit`` / ``userpractice`` schema at its parent revision.

SQLite runs the batch migration by rebuilding the table, so the round trip also
proves the partial unique index ``ix_user_practice_active_stage`` -- "one open
selection per stage" -- comes through both directions with its predicate.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

# The chain head this migration was written against, and the migration itself.
_BASE_REVISION = "b6d8f0a2c4e6"  # pragma: allowlist secret
_REVISION = "c8f1d3e5a7b9"  # pragma: allowlist secret

_TABLE = "userpractice"
_COLUMN = "habit_id"
_INDEX = "ix_userpractice_habit_id"
_ACTIVE_STAGE_INDEX = "ix_user_practice_active_stage"

_LINK_HABIT_SEVEN = text("UPDATE userpractice SET habit_id = 7 WHERE id = 1")
_SECOND_OPEN_SELECTION = text(
    "INSERT INTO userpractice (user_id, practice_id, stage_number, start_date)"
    " VALUES (1, 1, 1, '2026-10-13')"
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


def _bootstrap(db_url: str) -> None:
    """Create the tables this migration touches, as they stand at the parent.

    One user owns one habit and one open selection with a custom name, so the
    round trip can prove an existing row survives both directions.
    """
    with _connect(db_url) as conn:
        conn.execute(text("CREATE TABLE user (id INTEGER PRIMARY KEY, email VARCHAR(254))"))
        conn.execute(text("CREATE TABLE practice (id INTEGER PRIMARY KEY)"))
        conn.execute(
            text(
                "CREATE TABLE habit (id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL REFERENCES user (id))"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE userpractice (id INTEGER PRIMARY KEY,"
                " user_id INTEGER NOT NULL REFERENCES user (id) ON DELETE CASCADE,"
                " practice_id INTEGER NOT NULL REFERENCES practice (id),"
                " stage_number INTEGER NOT NULL,"
                " start_date DATE NOT NULL,"
                " end_date DATE,"
                " custom_name VARCHAR(255),"
                " mode_config_override JSON)"
            )
        )
        conn.execute(
            text(
                f'CREATE UNIQUE INDEX "{_ACTIVE_STAGE_INDEX}" '
                "ON userpractice (user_id, stage_number) WHERE end_date IS NULL"
            )
        )
        conn.execute(text("INSERT INTO user (id, email) VALUES (1, 'sitter@example.com')"))
        conn.execute(text("INSERT INTO practice (id) VALUES (1)"))
        conn.execute(text("INSERT INTO habit (id, user_id) VALUES (7, 1)"))
        conn.execute(
            text(
                "INSERT INTO userpractice"
                " (id, user_id, practice_id, stage_number, start_date, custom_name)"
                " VALUES (1, 1, 1, 1, '2026-10-01', 'Morning sit')"
            )
        )


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """A SQLite database stamped at this migration's parent revision."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'user_practice_habit.sqlite'}"
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


def _selection(db_url: str) -> dict[str, Any]:
    with _connect(db_url) as conn:
        row = conn.execute(text("SELECT * FROM userpractice WHERE id = 1")).mappings().one()
        return dict(row)


def _assert_one_open_selection_per_stage(db_url: str) -> None:
    """The partial unique index still refuses a second open selection for the stage."""
    with pytest.raises(IntegrityError, match="UNIQUE"), _connect(db_url) as conn:
        conn.execute(_SECOND_OPEN_SELECTION)


def test_the_migration_chains_from_its_authored_head(migration_config: Config) -> None:
    """One linear chain: this revision extends the head it was written against."""
    script = ScriptDirectory.from_config(migration_config)
    revision = script.get_revision(_REVISION)
    assert revision is not None
    assert revision.down_revision == _BASE_REVISION
    heads = script.get_heads()
    assert len(heads) == 1
    assert _REVISION in {rev.revision for rev in script.iterate_revisions(heads[0], "base")}


def test_upgrade_adds_a_nullable_indexed_link_and_keeps_the_row(
    migration_config: Config,
) -> None:
    """The column lands nullable and unset; the row and the active-stage index survive."""
    command.upgrade(migration_config, _REVISION)

    db_url = _url(migration_config)
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        columns = {c["name"]: c for c in inspect(engine).get_columns(_TABLE)}
        indexes = {i["name"] for i in inspect(engine).get_indexes(_TABLE)}
        fks = inspect(engine).get_foreign_keys(_TABLE)
    finally:
        engine.dispose()
    assert columns[_COLUMN]["nullable"] is True
    assert {_INDEX, _ACTIVE_STAGE_INDEX} <= indexes
    link_fks = [fk for fk in fks if fk["constrained_columns"] == [_COLUMN]]
    assert len(link_fks) == 1
    assert link_fks[0]["referred_table"] == "habit"
    assert link_fks[0]["options"].get("ondelete") == "SET NULL"

    row = _selection(db_url)
    assert row[_COLUMN] is None
    assert row["custom_name"] == "Morning sit"
    _assert_one_open_selection_per_stage(db_url)


def test_deleting_the_linked_habit_nulls_the_migrated_column(migration_config: Config) -> None:
    """With foreign keys enforced, the migrated FK unlinks rather than blocks or cascades."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    with _connect(db_url) as conn:
        conn.execute(_LINK_HABIT_SEVEN)

    with _connect(db_url, foreign_keys=True) as conn:
        conn.execute(text("DELETE FROM habit WHERE id = 7"))

    row = _selection(db_url)
    assert row[_COLUMN] is None
    assert row["custom_name"] == "Morning sit"


def test_downgrade_drops_the_link_and_re_upgrade_restores_it(migration_config: Config) -> None:
    """Down removes only the column and keeps the index; up again is clean."""
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    with _connect(db_url) as conn:
        conn.execute(_LINK_HABIT_SEVEN)

    command.downgrade(migration_config, _BASE_REVISION)

    row = _selection(db_url)
    assert _COLUMN not in row
    assert row["custom_name"] == "Morning sit"
    _assert_one_open_selection_per_stage(db_url)

    command.upgrade(migration_config, _REVISION)
    assert _selection(db_url)[_COLUMN] is None
