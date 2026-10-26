"""The event migration preserves aggregates, matches metadata and enforces provenance."""

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Connection, create_engine, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlmodel import SQLModel

_BASE = "06ce4a324061"  # pragma: allowlist secret
_REVISION = "47b290cfd812"  # pragma: allowlist secret
_TABLE = "goallogevent"
_INSERT = text(
    "INSERT INTO goallogevent "
    "(goal_id, user_id, timestamp, local_day, delta_units, via_timer, source) "
    "VALUES (:owner, :owner, '2026-10-25 18:00:00', '2026-10-24', :delta, 0, :source)"
)


@contextmanager
def _connect(config: Config) -> Iterator[Connection]:
    """Connect to the isolated fixture with actual database cascades enabled."""
    url = config.get_main_option("sqlalchemy.url")
    assert url is not None
    engine = create_engine(url.replace("+aiosqlite", ""))
    try:
        with engine.begin() as connection:
            connection.execute(text("PRAGMA foreign_keys=ON"))
            yield connection
    finally:
        engine.dispose()


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """Minimal pre-event schema, including an already-recorded daily aggregate."""
    url = f"sqlite+aiosqlite:///{tmp_path / 'events.sqlite'}"
    monkeypatch.setenv("DATABASE_URL", url)
    config = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    config.config_file_name = None
    config.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    config.set_main_option("sqlalchemy.url", url)
    with _connect(config) as connection:
        connection.execute(text("CREATE TABLE user (id INTEGER PRIMARY KEY)"))
        connection.execute(text("CREATE TABLE goal (id INTEGER PRIMARY KEY)"))
        connection.execute(text("INSERT INTO user (id) VALUES (1), (2)"))
        connection.execute(text("INSERT INTO goal (id) VALUES (1), (2)"))
        connection.execute(text("CREATE TABLE goalcompletion (id INTEGER PRIMARY KEY)"))
        connection.execute(text("INSERT INTO goalcompletion (id) VALUES (1)"))
    command.stamp(config, _BASE)
    return config


def test_migration_matches_the_model_and_backfills_nothing(migration_config: Config) -> None:
    """All event columns/indexes agree; historical days retain unknown log times."""
    command.upgrade(migration_config, _REVISION)
    with _connect(migration_config) as connection:
        inspector = inspect(connection)
        migrated = {column["name"]: column["nullable"] for column in inspector.get_columns(_TABLE)}
        indexes = {tuple(index["column_names"]) for index in inspector.get_indexes(_TABLE)}
        assert connection.execute(text("SELECT COUNT(*) FROM goallogevent")).scalar_one() == 0
        assert connection.execute(text("SELECT COUNT(*) FROM goalcompletion")).scalar_one() == 1
    assert migrated == {
        column.name: column.nullable for column in SQLModel.metadata.tables[_TABLE].columns
    }
    assert indexes == {("goal_id", "user_id", "timestamp")}


@pytest.mark.parametrize("parent", ["goal", "user"])
def test_parent_deletion_cascades_only_its_events(migration_config: Config, parent: str) -> None:
    """The actual migrated FKs erase one owner's event while preserving the other."""
    command.upgrade(migration_config, _REVISION)
    with _connect(migration_config) as connection:
        for owner in (1, 2):
            connection.execute(_INSERT, {"owner": owner, "delta": 32, "source": "manual"})
        deletions = {
            "user": text("DELETE FROM user WHERE id = 1"),
            "goal": text("DELETE FROM goal WHERE id = 1"),
        }
        connection.execute(deletions[parent])
        assert connection.execute(text("SELECT user_id FROM goallogevent")).scalars().all() == [2]


@pytest.mark.parametrize(("delta", "source"), [(0, "manual"), (1, "unknown")])
def test_database_rejects_zero_changes_and_unknown_sources(
    migration_config: Config, delta: int, source: str
) -> None:
    """A writer cannot bypass event constraints by skipping application validation."""
    command.upgrade(migration_config, _REVISION)
    with _connect(migration_config) as connection, pytest.raises(IntegrityError, match="CHECK"):
        connection.execute(_INSERT, {"owner": 1, "delta": delta, "source": source})


def test_downgrade_keeps_daily_aggregates(migration_config: Config) -> None:
    """Only the new provenance table disappears on downgrade."""
    command.upgrade(migration_config, _REVISION)
    command.downgrade(migration_config, _BASE)
    with _connect(migration_config) as connection:
        assert _TABLE not in inspect(connection).get_table_names()
        assert connection.execute(text("SELECT COUNT(*) FROM goalcompletion")).scalar_one() == 1
