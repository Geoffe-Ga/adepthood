"""Round trip for the vault-agent refresh token table (#3533).

The local half of the migration/model agreement the Postgres ``alembic check``
gate enforces in CI: upgrade on SQLite, compare the columns with the model,
prove the grant and account cascades, the digest's uniqueness, and that the
downgrade removes the table.
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

from models.oauth_refresh_token import OAuthRefreshToken

_BASE_REVISION = "bc3e90210168"  # pragma: allowlist secret
_REVISION = "06ce4a324061"  # pragma: allowlist secret
_PRE_OAUTH_REVISION = "b2c3d4e5f6a8"  # pragma: allowlist secret
_TABLE = OAuthRefreshToken.__tablename__


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
    """A database holding ``user`` and the OAuth tables, at the revision before this one."""
    async_url = f"sqlite+aiosqlite:///{tmp_path / 'oauth_refresh_token.sqlite'}"
    monkeypatch.setenv("DATABASE_URL", async_url)
    with _connect(async_url) as connection:
        connection.execute(text("CREATE TABLE user (id INTEGER PRIMARY KEY)"))
        connection.execute(text("INSERT INTO user (id) VALUES (1), (2)"))
    config = Config(str(Path(__file__).parent.parent / "alembic.ini"))
    config.config_file_name = None
    config.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    config.set_main_option("sqlalchemy.url", async_url)
    command.stamp(config, _PRE_OAUTH_REVISION)
    command.upgrade(config, _BASE_REVISION)
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


def _seed_grants(connection: Connection) -> None:
    """One agent, approved by both accounts."""
    connection.execute(
        text(
            "INSERT INTO oauth_client (id, client_id, client_name, redirect_uris, source, "
            "created_at) VALUES (1, 'cl_x', 'Agent', '[]', 'dcr', '2026-10-24 00:00:00')"
        )
    )
    for user_id in (1, 2):
        connection.execute(
            text(
                "INSERT INTO agent_grant (id, user_id, client_id, grants, resource, created_at) "
                "VALUES (:id, :id, 'cl_x', '[]', 'https://vault.example/mcp', "
                "'2026-10-24 00:00:00')"
            ),
            {"id": user_id},
        )


def _insert_token(connection: Connection, token_hash: str, grant_id: int) -> None:
    connection.execute(
        text(
            "INSERT INTO oauth_refresh_token (token_hash, family_id, grant_id, user_id, "
            "created_at, expires_at) VALUES (:hash, 'f', :grant, :grant, "
            "'2026-10-24 00:00:00', '2026-10-24 00:00:00')"
        ),
        {"hash": token_hash, "grant": grant_id},
    )


def test_the_revision_extends_the_oauth_tables(migration_config: Config) -> None:
    """One linear chain: this revision sits on A1's and the single head descends from it."""
    script = ScriptDirectory.from_config(migration_config)
    revision = script.get_revision(_REVISION)
    assert revision is not None
    assert revision.down_revision == _BASE_REVISION
    heads = script.get_heads()
    assert len(heads) == 1
    assert _REVISION in {rev.revision for rev in script.iterate_revisions(heads[0], "base")}


def test_the_migrated_columns_are_exactly_the_models(migration_config: Config) -> None:
    """Every column the model declares is created, with the same nullability, and no other."""
    command.upgrade(migration_config, _REVISION)
    engine = create_engine(_url(migration_config).replace("+aiosqlite", ""))
    try:
        migrated = {c["name"]: c["nullable"] for c in inspect(engine).get_columns(_TABLE)}
    finally:
        engine.dispose()
    modelled = {c.name: c.nullable for c in SQLModel.metadata.tables[_TABLE].columns}
    assert migrated == modelled


def test_a_grant_or_an_account_takes_its_refresh_tokens_with_it(
    migration_config: Config,
) -> None:
    """Deleting grant 1 empties its family; erasing account 2 empties its own."""
    command.upgrade(migration_config, _REVISION)
    with _connect(_url(migration_config)) as connection:
        _seed_grants(connection)
        _insert_token(connection, "h1", 1)
        _insert_token(connection, "h2", 2)
        connection.execute(text("DELETE FROM agent_grant WHERE id = 1"))
        after_grant = (
            connection.execute(text("SELECT grant_id FROM oauth_refresh_token")).scalars().all()
        )
        connection.execute(text("DELETE FROM user WHERE id = 2"))
        after_user = connection.execute(
            text("SELECT COUNT(*) FROM oauth_refresh_token")
        ).scalar_one()
    assert after_grant == [2]
    assert after_user == 0


def test_a_digest_is_stored_once(migration_config: Config) -> None:
    """Two rows for one token would make the lookup ambiguous; the database refuses it."""
    command.upgrade(migration_config, _REVISION)
    with _connect(_url(migration_config)) as connection:
        _seed_grants(connection)
        _insert_token(connection, "same", 1)
        with pytest.raises(IntegrityError, match="UNIQUE"):
            _insert_token(connection, "same", 2)


def test_downgrade_removes_the_table(migration_config: Config) -> None:
    """Reversing the revision leaves A1's schema exactly as it found it."""
    command.upgrade(migration_config, _REVISION)
    assert _TABLE in _table_names(migration_config)
    command.downgrade(migration_config, _BASE_REVISION)
    assert _TABLE not in _table_names(migration_config)
    assert "agent_grant" in _table_names(migration_config)
