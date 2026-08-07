"""Proof that the lane's schema was built by migrations, not ``create_all``.

Every other assertion in this package is worthless if the database underneath
it was stood up the way the SQLite fixture does it -- ``metadata.create_all``
plus hand-written index mirrors -- because that schema is exactly the
approximation the lane exists to stop trusting. These tests read the schema
back out of the live server and refuse anything that did not come from
``alembic upgrade head``.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

pytestmark = pytest.mark.integration

_ALEMBIC_INI = Path(__file__).resolve().parents[2] / "alembic.ini"

# Functional / partial unique indexes that only a migration creates. The SQLite
# fixture mirrors five of these by hand under ``_test``-suffixed names; on a
# migrated database the real ones must be here under their real names.
_MIGRATION_OWNED_INDEXES = frozenset(
    {
        "ix_habit_user_lower_name_unique",
        "ix_goal_completion_unique_per_day",
        "ix_practice_preset_stage_lower_name_unique",
        "ix_coursestage_stage_number_unique",
        "ix_stagecontent_stage_content_ref_unique",
        "ix_user_lower_email_unique",
    }
)

# The suffix ``backend/conftest.py`` gives its SQLite stand-ins. Finding one
# here would mean the lane is running against the fixture's approximation.
_MIRROR_INDEX_SUFFIX = "_test"

# Columns declared ``ARRAY`` in the models and rewritten to ``JSON`` by the
# SQLite fixture. On a migrated Postgres they must still be arrays.
_ARRAY_COLUMNS = [
    ("habit", "notification_days"),
    ("habit", "notification_times"),
    ("goal", "days_of_week"),
    ("stageprogress", "completed_stages"),
]

_MINIMUM_SERVER_VERSION_NUM = 160_000


async def _public_index_names(session: AsyncSession) -> set[str]:
    """Return every index name in the live database's ``public`` schema."""
    result = await session.execute(
        text("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")
    )
    return set(result.scalars().all())


@pytest.mark.asyncio
async def test_schema_is_stamped_at_the_alembic_script_heads(pg_session: AsyncSession) -> None:
    """``alembic_version`` must hold exactly the script directory's head set.

    The expected value is read from the migration scripts rather than pinned to
    a literal revision, so adding a migration cannot leave this test asserting
    a stale head and a partially-migrated lane cannot pass.
    """
    heads = set(ScriptDirectory.from_config(Config(str(_ALEMBIC_INI))).get_heads())
    assert heads, "the alembic script directory reports no head revisions"

    result = await pg_session.execute(text("SELECT version_num FROM alembic_version"))

    assert set(result.scalars().all()) == heads


@pytest.mark.asyncio
async def test_migration_owned_indexes_are_all_present(pg_session: AsyncSession) -> None:
    """Every functional / partial unique index a migration creates exists here."""
    present = await _public_index_names(pg_session)

    assert sorted(_MIGRATION_OWNED_INDEXES - present) == []


@pytest.mark.asyncio
async def test_no_sqlite_mirror_index_exists(pg_session: AsyncSession) -> None:
    """None of the SQLite fixture's hand-written stand-ins may appear.

    A ``..._test`` index here would mean the lane inherited the approximation
    it was built to replace.
    """
    present = await _public_index_names(pg_session)

    assert sorted(name for name in present if name.endswith(_MIRROR_INDEX_SUFFIX)) == []


@pytest.mark.asyncio
async def test_connection_speaks_the_postgresql_dialect(pg_session: AsyncSession) -> None:
    """A SQLite fallback in the fixture must fail loudly, right here."""
    connection = await pg_session.connection()

    assert connection.dialect.name == "postgresql"


@pytest.mark.asyncio
async def test_server_is_a_live_postgres_16(pg_session: AsyncSession) -> None:
    """The server banner and version number must both report Postgres 16 or newer."""
    banner = await pg_session.scalar(text("SELECT version()"))
    version_num = await pg_session.scalar(text("SELECT current_setting('server_version_num')::int"))

    assert isinstance(banner, str)
    assert banner.startswith("PostgreSQL ")
    assert version_num >= _MINIMUM_SERVER_VERSION_NUM


@pytest.mark.asyncio
@pytest.mark.parametrize(("table_name", "column_name"), _ARRAY_COLUMNS)
async def test_array_columns_are_declared_as_arrays(
    pg_session: AsyncSession, table_name: str, column_name: str
) -> None:
    """The ARRAY columns the SQLite fixture rewrites to JSON stay arrays here."""
    data_type = await pg_session.scalar(
        text(
            "SELECT data_type FROM information_schema.columns "
            "WHERE table_schema = 'public' "
            "AND table_name = :table_name AND column_name = :column_name"
        ),
        {"table_name": table_name, "column_name": column_name},
    )

    assert data_type == "ARRAY"
