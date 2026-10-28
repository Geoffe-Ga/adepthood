"""Round trip for the OAuth authorization server tables (#3532).

The migration and the models must agree column for column, because the
Postgres ``alembic check`` gate only runs in CI. This is the local half of that
guarantee: upgrade on SQLite, compare every created table's columns with the
model's, prove the account cascade holds, and prove the downgrade removes all
three tables.
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
from sqlmodel import SQLModel

from models.agent_grant import AgentGrant
from models.oauth_authorization_code import OAuthAuthorizationCode
from models.oauth_client import OAuthClient

_BASE_REVISION = "b2c3d4e5f6a8"  # pragma: allowlist secret
_REVISION = "bc3e90210168"  # pragma: allowlist secret
_TABLES = (
    OAuthClient.__tablename__,
    OAuthAuthorizationCode.__tablename__,
    AgentGrant.__tablename__,
)


@contextmanager
def _connect(db_url: str) -> Iterator[Connection]:
    """Open a committing synchronous connection with foreign keys enforced."""
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    try:
        with engine.begin() as connection:
            connection.execute(text("PRAGMA foreign_keys=ON"))
            yield connection
    finally:
        engine.dispose()


@pytest.fixture
def migration_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    """A database holding only ``user``, stamped at the revision before this one."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'oauth_authorization_server.sqlite'}"
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
    value = config.get_main_option("sqlalchemy.url")
    assert value is not None
    return value


def _table_names(config: Config) -> set[str]:
    engine = create_engine(_url(config).replace("+aiosqlite", ""))
    try:
        return set(inspect(engine).get_table_names())
    finally:
        engine.dispose()


def test_the_revision_extends_the_head_it_was_authored_against(migration_config: Config) -> None:
    """One linear chain: this revision sits on its base and the single head descends from it."""
    script = ScriptDirectory.from_config(migration_config)
    revision = script.get_revision(_REVISION)
    assert revision is not None
    assert revision.down_revision == _BASE_REVISION
    heads = script.get_heads()
    assert len(heads) == 1
    assert _REVISION in {rev.revision for rev in script.iterate_revisions(heads[0], "base")}


@pytest.mark.parametrize("table", _TABLES)
def test_the_migrated_columns_are_exactly_the_models(migration_config: Config, table: str) -> None:
    """Every column the model declares is created, with the same nullability, and no other."""
    command.upgrade(migration_config, _REVISION)
    engine = create_engine(_url(migration_config).replace("+aiosqlite", ""))
    try:
        migrated = {c["name"]: c["nullable"] for c in inspect(engine).get_columns(table)}
    finally:
        engine.dispose()
    modelled = {c.name: c.nullable for c in SQLModel.metadata.tables[table].columns}
    assert migrated == modelled


def test_erasing_an_account_cascades_to_its_codes_and_grants(migration_config: Config) -> None:
    """The account's approvals go with it; the anonymous client registry stays."""
    command.upgrade(migration_config, _REVISION)
    with _connect(_url(migration_config)) as connection:
        connection.execute(
            text(
                "INSERT INTO oauth_client (id, client_id, client_name, redirect_uris, source, "
                "created_at) VALUES (1, 'cl_x', 'Agent', '[]', 'dcr', '2026-10-24 00:00:00')"
            )
        )
        for user_id in (1, 2):
            connection.execute(
                text(
                    "INSERT INTO agent_grant (user_id, client_id, grants, resource, created_at) "
                    "VALUES (:user_id, 'cl_x', '[]', 'https://vault.example/mcp', "
                    "'2026-10-24 00:00:00')"
                ),
                {"user_id": user_id},
            )
            connection.execute(
                text(
                    "INSERT INTO oauth_authorization_code (code_hash, client_id, user_id, "
                    "redirect_uri, code_challenge, code_challenge_method, resource, scope, "
                    "created_at, expires_at) VALUES (:hash, 'cl_x', :user_id, "
                    "'https://agent.example/cb', 'c', 'S256', 'https://vault.example/mcp', "
                    "'vault:read', '2026-10-24 00:00:00', '2026-10-24 00:01:00')"
                ),
                {"hash": f"h{user_id}", "user_id": user_id},
            )
        connection.execute(text("DELETE FROM user WHERE id = 1"))
        grants = connection.execute(text("SELECT user_id FROM agent_grant")).scalars().all()
        codes = (
            connection.execute(text("SELECT user_id FROM oauth_authorization_code")).scalars().all()
        )
        clients = connection.execute(text("SELECT COUNT(*) FROM oauth_client")).scalar_one()
    assert grants == [2]
    assert codes == [2]
    assert clients == 1


def test_one_grant_per_account_and_agent(migration_config: Config) -> None:
    """A second grant row for the same pair is refused by the database itself."""
    command.upgrade(migration_config, _REVISION)
    insert = text(
        "INSERT INTO agent_grant (user_id, client_id, grants, resource, created_at) "
        "VALUES (1, 'cl_x', '[]', 'https://vault.example/mcp', '2026-10-24 00:00:00')"
    )
    with _connect(_url(migration_config)) as connection:
        connection.execute(
            text(
                "INSERT INTO oauth_client (id, client_id, client_name, redirect_uris, source, "
                "created_at) VALUES (1, 'cl_x', 'Agent', '[]', 'dcr', '2026-10-24 00:00:00')"
            )
        )
        connection.execute(insert)
        with pytest.raises(IntegrityError, match="UNIQUE"):
            connection.execute(insert)


def test_downgrade_removes_all_three_tables(migration_config: Config) -> None:
    """Reversing the revision leaves the schema exactly as it found it."""
    command.upgrade(migration_config, _REVISION)
    assert set(_TABLES) <= _table_names(migration_config)
    command.downgrade(migration_config, _BASE_REVISION)
    assert not set(_TABLES) & _table_names(migration_config)
