"""Startup refuses a database whose Alembic stamp is not at repository head."""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from database_schema import (
    DatabaseSchemaMismatchError,
    alembic_script_heads,
    require_database_schema_current,
)


def _sqlite_engine(tmp_path: Path) -> AsyncEngine:
    """Return an isolated async database for one revision-check test."""
    return create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'schema.db'}")


@pytest.mark.asyncio
async def test_an_unversioned_database_is_rejected_with_the_recovery_command(
    tmp_path: Path,
) -> None:
    """A missing Alembic stamp must fail at startup, not at the first journal write."""
    engine = _sqlite_engine(tmp_path)
    try:
        with pytest.raises(DatabaseSchemaMismatchError) as raised:
            await require_database_schema_current(engine)
    finally:
        await engine.dispose()

    message = str(raised.value)
    assert "alembic_version" in message
    assert "cd backend && alembic upgrade head" in message


@pytest.mark.asyncio
async def test_a_database_stamped_at_every_script_head_is_accepted(tmp_path: Path) -> None:
    """The expected revision is derived from the migration graph, never hard-coded."""
    engine = _sqlite_engine(tmp_path)
    heads = alembic_script_heads()
    assert heads
    try:
        async with engine.begin() as connection:
            await connection.execute(
                text("CREATE TABLE alembic_version (version_num VARCHAR(32) PRIMARY KEY)")
            )
            for revision in heads:
                await connection.execute(
                    text("INSERT INTO alembic_version (version_num) VALUES (:revision)"),
                    {"revision": revision},
                )

        await require_database_schema_current(engine)
    finally:
        await engine.dispose()
