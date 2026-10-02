"""The ``coursestage`` stage-key migration round-trips on a real Postgres (#2665).

The SQLite unit test proves the backfill and rebuild; this proves the same
revision's DDL and its ``CASE`` / ``||`` backfill on the production dialect:
``downgrade`` to the parent, legacy rows written there, ``upgrade head``
backfilling them in place, and both unique indexes present in ``pg_indexes``.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel import col, select

from models.course_stage import CourseStage

pytestmark = pytest.mark.integration

_BACKEND_ROOT = Path(__file__).resolve().parents[2]
_ALEMBIC_INI = _BACKEND_ROOT / "alembic.ini"
_MIGRATIONS = _BACKEND_ROOT / "migrations"
_DATABASE_URL_ENV = "DATABASE_URL"

_PARENT_REVISION = "d6f1a8c4e2b9"  # pragma: allowlist secret
_KEY_INDEX = "ix_coursestage_stage_key_unique"
_NUMBER_INDEX = "ix_coursestage_stage_number_unique"
_NEW_COLUMNS = frozenset(
    {
        "stage_key",
        "source_repo",
        "source_sha",
        "source_path",
        "source_sha256",
        "artifact_schema_version",
        "reconciled_at",
    }
)
#: (stage_number, expected key): two real Stages and one out-of-range row.
_LEGACY_ROWS = ((4, "blue"), (10, "clearlight"), (11, "stage-11"))


def _config(url: str) -> Config:
    """Return an Alembic config bound to the isolated integration database."""
    config = Config(str(_ALEMBIC_INI))
    config.config_file_name = None
    config.set_main_option("script_location", str(_MIGRATIONS))
    config.set_main_option("sqlalchemy.url", url)
    return config


async def _execute(url: str, statement: str, params: dict[str, object] | None = None) -> None:
    """Run one committed statement against ``url``."""
    engine = create_async_engine(url, poolclass=NullPool)
    try:
        async with engine.begin() as connection:
            await connection.execute(text(statement), params or {})
    finally:
        await engine.dispose()


async def _rows(url: str, statement: str) -> list[tuple[object, ...]]:
    """Return every row ``statement`` selects from ``url``."""
    engine = create_async_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as connection:
            result = await connection.execute(text(statement))
            return [tuple(row) for row in result.all()]
    finally:
        await engine.dispose()


def _coursestage_columns(url: str) -> set[str]:
    """The live ``coursestage`` column names."""
    rows = asyncio.run(
        _rows(
            url,
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = 'coursestage'",
        )
    )
    return {str(row[0]) for row in rows}


def _coursestage_indexes(url: str) -> set[str]:
    """The live ``coursestage`` index names."""
    rows = asyncio.run(
        _rows(
            url,
            "SELECT indexname FROM pg_indexes "
            "WHERE schemaname = 'public' AND tablename = 'coursestage'",
        )
    )
    return {str(row[0]) for row in rows}


def _insert_legacy_rows(url: str) -> None:
    """Write pre-revision rows (no key, no provenance) at the parent revision."""
    for stage_number, _key in _LEGACY_ROWS:
        asyncio.run(
            _execute(
                url,
                "INSERT INTO coursestage (title, subtitle, stage_number, overview_url,"
                " category, aspect, spiral_dynamics_color, growing_up_stage,"
                " divine_gender_polarity, relationship_to_free_will, free_will_description)"
                " VALUES ('t', 's', :n, '', 'c', 'a', 'x', 'g', 'd', 'r', 'f')",
                {"n": stage_number},
            )
        )


@pytest.fixture
def migrated_url(pg_database_url: str, monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    """The lane database, always returned to head and emptied of test rows."""
    monkeypatch.setenv(_DATABASE_URL_ENV, pg_database_url)
    try:
        yield pg_database_url
    finally:
        command.upgrade(_config(pg_database_url), "head")
        asyncio.run(_execute(pg_database_url, "DELETE FROM coursestage"))


def test_downgrade_then_upgrade_backfills_keys_on_postgres(migrated_url: str) -> None:
    """Down drops the columns and index; up backfills existing rows and restores both."""
    config = _config(migrated_url)
    assert {_KEY_INDEX, _NUMBER_INDEX} <= _coursestage_indexes(migrated_url)

    command.downgrade(config, _PARENT_REVISION)
    assert not _NEW_COLUMNS & _coursestage_columns(migrated_url)
    assert _KEY_INDEX not in _coursestage_indexes(migrated_url)
    assert _NUMBER_INDEX in _coursestage_indexes(migrated_url)
    _insert_legacy_rows(migrated_url)

    command.upgrade(config, "head")

    assert _coursestage_columns(migrated_url) >= _NEW_COLUMNS
    assert {_KEY_INDEX, _NUMBER_INDEX} <= _coursestage_indexes(migrated_url)
    keys = asyncio.run(
        _rows(migrated_url, "SELECT stage_number, stage_key FROM coursestage ORDER BY 1")
    )
    assert keys == list(_LEGACY_ROWS)
    nullable = asyncio.run(
        _rows(
            migrated_url,
            "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public'"
            " AND table_name = 'coursestage' AND column_name = 'stage_key'",
        )
    )
    assert nullable == [("NO",)]


def _keyless(stage_number: int) -> CourseStage:
    """A hand-built row with no ``stage_key``."""
    return CourseStage(
        stage_number=stage_number,
        title=f"Stage {stage_number}",
        subtitle="s",
        overview_url="",
        category="c",
        aspect="a",
        spiral_dynamics_color="x",
        growing_up_stage="g",
        divine_gender_polarity="d",
        relationship_to_free_will="r",
        free_will_description="f",
    )


@pytest.mark.asyncio
async def test_the_key_default_is_per_row_under_postgres_batching(
    pg_session: AsyncSession,
) -> None:
    """Asyncpg's batched INSERT still derives each row's key from its own number."""
    pg_session.add_all([_keyless(number) for number, _key in _LEGACY_ROWS])
    await pg_session.flush()

    rows = (
        await pg_session.execute(
            select(CourseStage.stage_number, CourseStage.stage_key).order_by(
                col(CourseStage.stage_number)
            )
        )
    ).all()
    assert [tuple(row) for row in rows] == list(_LEGACY_ROWS)
