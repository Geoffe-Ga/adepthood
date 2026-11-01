"""Round trip for the per-allocation agent MCP resource column (#3584, R3-1).

The local half of the migration/model agreement the Postgres ``alembic check``
gate enforces in CI: upgrade on SQLite from the revision before, compare the
column and its index with the model, prove existing rows stay on the shared
edge (``NULL``), that no two accounts may hold one resource, and that the
downgrade removes both.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, String, create_engine, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlmodel import SQLModel

from models.user_vault_config import VAULT_URL_MAX_LENGTH, UserVaultConfig

_BASE_REVISION = "1e941149a0c9"  # pragma: allowlist secret
_REVISION = "5d3c8a1f9b27"  # pragma: allowlist secret
_TABLE = "uservaultconfig"
_COLUMN = "agent_mcp_resource"
_INDEX = "ix_uservaultconfig_agent_mcp_resource"
_RESOURCE = "https://edge.vaults.example/a/" + "a" * 32 + "/mcp"
_READ = text("SELECT agent_mcp_resource FROM uservaultconfig ORDER BY id")
_ADOPT = text("UPDATE uservaultconfig SET agent_mcp_resource = :r WHERE id = :id")


@contextmanager
def _connect(db_url: str) -> Iterator[Connection]:
    """Open a committing synchronous connection."""
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        with engine.begin() as connection:
            yield connection
    finally:
        engine.dispose()


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """Two connected vaults, stamped at the revision before this one."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'agent_mcp_resource.sqlite'}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    with _connect(async_url) as connection:
        connection.execute(
            text(
                f"CREATE TABLE {_TABLE} (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE, "
                "vault_url VARCHAR(2048) NOT NULL, api_key TEXT NOT NULL, "
                "provisioned BOOLEAN NOT NULL)"
            )
        )
        connection.execute(
            text(
                "INSERT INTO uservaultconfig (id, user_id, vault_url, api_key, provisioned) VALUES "
                "(1, 1, 'https://edge.vaults.example/v1', 'k1', 1), "
                "(2, 2, 'https://edge.vaults.example/v1', 'k2', 1)"
            )
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


def test_the_revision_follows_its_base() -> None:
    """The chain stays linear: this revision's parent is the previous head."""
    config = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    config.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    revision = ScriptDirectory.from_config(config).get_revision(_REVISION)
    assert revision is not None
    assert revision.down_revision == _BASE_REVISION


def test_upgrade_adds_a_nullable_unique_resource_matching_the_model(
    migration_config: Config,
) -> None:
    """Existing vaults stay on the shared edge; one resource is one account's."""
    command.upgrade(migration_config, _REVISION)
    engine = create_engine(_url(migration_config).replace("+aiosqlite", ""))
    try:
        inspector = inspect(engine)
        (column,) = [c for c in inspector.get_columns(_TABLE) if c["name"] == _COLUMN]
        indexes = {index["name"]: index for index in inspector.get_indexes(_TABLE)}
    finally:
        engine.dispose()
    assert UserVaultConfig.__tablename__ == _TABLE
    model_column = SQLModel.metadata.tables[_TABLE].c[_COLUMN]
    assert column["nullable"] is True
    assert isinstance(column["type"], String)
    assert column["type"].length == VAULT_URL_MAX_LENGTH
    assert model_column.nullable
    assert model_column.unique
    assert indexes[_INDEX]["column_names"] == [_COLUMN]
    assert indexes[_INDEX]["unique"]

    with _connect(_url(migration_config)) as connection:
        stored = connection.execute(_READ)
        assert [row[0] for row in stored] == [None, None]
        connection.execute(_ADOPT, {"r": _RESOURCE, "id": 1})
    with pytest.raises(IntegrityError), _connect(_url(migration_config)) as connection:
        connection.execute(_ADOPT, {"r": _RESOURCE, "id": 2})


def test_downgrade_removes_the_column_and_its_index(migration_config: Config) -> None:
    """Every account returns to the shared-edge audience."""
    command.upgrade(migration_config, _REVISION)
    command.downgrade(migration_config, _BASE_REVISION)
    engine = create_engine(_url(migration_config).replace("+aiosqlite", ""))
    try:
        inspector = inspect(engine)
        assert _COLUMN not in {c["name"] for c in inspector.get_columns(_TABLE)}
        assert _INDEX not in {index["name"] for index in inspector.get_indexes(_TABLE)}
    finally:
        engine.dispose()
