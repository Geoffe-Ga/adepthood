"""Round trip for the managed-vault recovery-intent migration (#3021)."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, create_engine, inspect, text

_BASE_REVISION = "c4e6a8b0d2f1"  # pragma: allowlist secret
_REVISION = "d6f1a8c4e2b9"  # pragma: allowlist secret
_TABLE = "vaultactivation"


@contextmanager
def _connect(db_url: str) -> Iterator[Connection]:
    """Open a committing synchronous connection for the migration fixture."""
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        with engine.begin() as connection:
            yield connection
    finally:
        engine.dispose()


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """Build a legacy activation table stamped at the prior migration head."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'vault_recovery.sqlite'}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    with _connect(async_url) as connection:
        connection.execute(
            text(
                "CREATE TABLE vaultactivation ("
                "id INTEGER PRIMARY KEY, activation_id VARCHAR(200) NOT NULL)"
            )
        )
        connection.execute(
            text("INSERT INTO vaultactivation (id, activation_id) VALUES (1, 'activation-old')")
        )
    config = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    config.config_file_name = None
    config.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    config.set_main_option("sqlalchemy.url", async_url)
    command.stamp(config, _BASE_REVISION)
    return config


def _url(config: Config) -> str:
    value = config.get_main_option("sqlalchemy.url")
    assert value is not None
    return value


def test_recovery_intent_migration_is_the_linear_head(migration_config: Config) -> None:
    """The marker revision extends the exact head it was authored against."""
    script = ScriptDirectory.from_config(migration_config)
    revision = script.get_revision(_REVISION)
    assert revision is not None
    assert revision.down_revision == _BASE_REVISION
    assert script.get_heads() == [_REVISION]


def test_recovery_intent_upgrade_is_nullable_and_preserves_legacy_rows(
    migration_config: Config,
) -> None:
    """Existing activations remain non-recovery rows after the additive upgrade."""
    command.upgrade(migration_config, _REVISION)
    engine = create_engine(_url(migration_config).replace("+aiosqlite", ""))
    try:
        columns = {column["name"]: column for column in inspect(engine).get_columns(_TABLE)}
        with engine.connect() as connection:
            row = connection.execute(
                text("SELECT activation_id, recovery_requested_at FROM vaultactivation")
            ).one()
    finally:
        engine.dispose()
    assert columns["recovery_requested_at"]["nullable"] is True
    assert tuple(row) == ("activation-old", None)


def test_recovery_intent_downgrade_removes_only_the_marker(
    migration_config: Config,
) -> None:
    """Downgrade retains the activation row while removing the new column."""
    command.upgrade(migration_config, _REVISION)
    command.downgrade(migration_config, _BASE_REVISION)
    engine = create_engine(_url(migration_config).replace("+aiosqlite", ""))
    try:
        columns = {column["name"] for column in inspect(engine).get_columns(_TABLE)}
        with engine.connect() as connection:
            activation_id = connection.execute(
                text("SELECT activation_id FROM vaultactivation")
            ).scalar_one()
    finally:
        engine.dispose()
    assert "recovery_requested_at" not in columns
    assert activation_id == "activation-old"
