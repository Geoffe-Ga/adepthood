"""A behind-head Postgres is refused until the documented Alembic recovery."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from database_schema import DatabaseSchemaMismatchError, require_database_schema_current

pytestmark = pytest.mark.integration

_BACKEND_ROOT = Path(__file__).resolve().parents[2]
_ALEMBIC_INI = _BACKEND_ROOT / "alembic.ini"
_MIGRATIONS = _BACKEND_ROOT / "migrations"
_DATABASE_URL_ENV = "DATABASE_URL"


def _config(url: str) -> Config:
    """Return an Alembic config bound to the isolated integration database."""
    config = Config(str(_ALEMBIC_INI))
    config.config_file_name = None
    config.set_main_option("script_location", str(_MIGRATIONS))
    config.set_main_option("sqlalchemy.url", url)
    return config


async def _check(url: str) -> None:
    """Run the production schema guard against ``url`` and close its pool."""
    engine = create_async_engine(url, poolclass=NullPool)
    try:
        await require_database_schema_current(engine)
    finally:
        await engine.dispose()


def test_a_behind_head_database_is_rejected_and_upgrade_head_recovers(
    pg_database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Downgrade one real migration, observe refusal, then run the documented fix."""
    config = _config(pg_database_url)
    scripts = ScriptDirectory.from_config(config)
    head = scripts.get_current_head()
    assert head is not None
    previous = scripts.get_revision(head).down_revision
    assert isinstance(previous, str), "the current migration head must have one predecessor"

    monkeypatch.setenv(_DATABASE_URL_ENV, pg_database_url)
    command.downgrade(config, previous)
    try:
        with pytest.raises(DatabaseSchemaMismatchError, match="behind") as raised:
            asyncio.run(_check(pg_database_url))
        assert previous in str(raised.value)
        assert head in str(raised.value)

        command.upgrade(config, "head")
        asyncio.run(_check(pg_database_url))
    finally:
        command.upgrade(config, "head")
