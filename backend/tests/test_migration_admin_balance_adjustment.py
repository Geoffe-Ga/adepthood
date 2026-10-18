"""Round trip for the durable admin wallet-adjustment audit migration."""

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

_BASE_REVISION = "15c817227402"  # pragma: allowlist secret
_REVISION = "a1938b4c5d6e"  # pragma: allowlist secret
_TABLE = "adminbalanceadjustment"


@contextmanager
def _connect(db_url: str, *, foreign_keys: bool = False) -> Iterator[Connection]:
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        with engine.begin() as connection:
            if foreign_keys:
                connection.execute(text("PRAGMA foreign_keys = ON"))
            yield connection
    finally:
        engine.dispose()


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """A minimal parent-revision database with an admin and a target user."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'admin_adjustment.sqlite'}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    with _connect(async_url) as connection:
        connection.execute(text("CREATE TABLE user (id INTEGER PRIMARY KEY)"))
        connection.execute(text("INSERT INTO user (id) VALUES (1), (2)"))
    config = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    config.config_file_name = None
    config.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    config.set_main_option("sqlalchemy.url", async_url)
    command.stamp(config, _BASE_REVISION)
    return config


def _url(config: Config) -> str:
    url = config.get_main_option("sqlalchemy.url")
    assert url is not None
    return url


def _insert_adjustment(connection: Connection, *, key: str | None = "idem") -> None:
    connection.execute(
        text(
            "INSERT INTO adminbalanceadjustment "
            "(target_user_id, actor_admin_id, delta, balance_after, reason, source_ip, "
            "idempotency_key, request_fingerprint) "
            "VALUES (2, 1, 5, 12, 'support correction', '127.0.0.1', :key, 'fingerprint')"
        ),
        {"key": key},
    )


def test_migration_chains_from_the_previous_head(migration_config: Config) -> None:
    revision = ScriptDirectory.from_config(migration_config).get_revision(_REVISION)
    assert revision is not None
    assert revision.down_revision == _BASE_REVISION


def test_upgrade_creates_the_audit_and_keyed_replay_guard(migration_config: Config) -> None:
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        columns = {column["name"] for column in inspect(engine).get_columns(_TABLE)}
        indexes = {index["name"] for index in inspect(engine).get_indexes(_TABLE)}
    finally:
        engine.dispose()
    assert columns == {
        "id",
        "target_user_id",
        "actor_admin_id",
        "delta",
        "balance_after",
        "reason",
        "source_ip",
        "idempotency_key",
        "request_fingerprint",
        "created_at",
    }
    assert "ix_adminbalanceadjustment_actor_idem_key" in indexes

    with _connect(db_url) as connection:
        _insert_adjustment(connection)
    with pytest.raises(IntegrityError, match="UNIQUE"), _connect(db_url) as connection:
        _insert_adjustment(connection)
    with _connect(db_url) as connection:
        _insert_adjustment(connection, key=None)
        _insert_adjustment(connection, key=None)


def test_foreign_keys_preserve_target_history_and_erase_the_wallets_own_rows(
    migration_config: Config,
) -> None:
    command.upgrade(migration_config, _REVISION)
    db_url = _url(migration_config)
    with _connect(db_url) as connection:
        _insert_adjustment(connection)

    with _connect(db_url, foreign_keys=True) as connection:
        connection.execute(text("DELETE FROM user WHERE id = 1"))
        actor = connection.execute(
            text("SELECT actor_admin_id FROM adminbalanceadjustment")
        ).scalar_one()
    assert actor is None

    with _connect(db_url, foreign_keys=True) as connection:
        connection.execute(text("DELETE FROM user WHERE id = 2"))
        remaining = connection.execute(
            text("SELECT COUNT(*) FROM adminbalanceadjustment")
        ).scalar_one()
    assert remaining == 0


def test_downgrade_drops_the_audit_and_reupgrade_is_clean(migration_config: Config) -> None:
    command.upgrade(migration_config, _REVISION)
    command.downgrade(migration_config, _BASE_REVISION)
    db_url = _url(migration_config)
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        assert _TABLE not in inspect(engine).get_table_names()
    finally:
        engine.dispose()
    command.upgrade(migration_config, _REVISION)
    with _connect(db_url) as connection:
        _insert_adjustment(connection)
