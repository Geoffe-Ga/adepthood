"""Fixtures binding this package to a live Postgres migrated by alembic.

Run the lane locally against any reachable Postgres 16::

    cd backend
    export TEST_POSTGRES_URL=postgresql+asyncpg://USER:PASS@HOST/DB  # pragma: allowlist secret
    pytest -m integration

The account named in that URL needs CREATE DATABASE: the lane never touches the
database in the URL, only creates and drops one beside it.

With ``TEST_POSTGRES_URL`` unset the whole package skips, so the default SQLite
suite is unaffected. Setting ``INTEGRATION_LANE_REQUIRE_POSTGRES=1`` (as CI
does) removes that escape hatch: a missing URL then fails instead of skipping.

Lifecycle, and why it is split the way it is:

* The session-scoped fixture is **synchronous**. ``alembic.command.upgrade``
  runs ``asyncio.run`` internally via ``migrations/env.py``, which is legal
  from sync fixture context and illegal from inside a running loop. The admin
  DDL and the provenance check use ``asyncio.run`` from the same place for
  consistency.
* The engine and the HTTP client are **function-scoped**. pytest-asyncio gives
  each test its own event loop, and a session-scoped async engine would hand
  later tests connections bound to a loop that has already closed. Only object
  lifetime moves; the database is still created and migrated once per worker.
* Each test runs inside an outer transaction that is rolled back at teardown,
  with the session joined to it via savepoints so the routers' own ``commit``
  and ``begin_nested`` calls behave normally and still leave nothing behind.

Nothing here skips except the single "no URL configured" branch. A refused
connection, a non-Postgres dialect, a missing alembic stamp or a failed
CREATE DATABASE are all defects of the lane itself and must be loud.
"""

from __future__ import annotations

import asyncio
import os
import re
from collections.abc import AsyncGenerator, Iterator
from pathlib import Path

import pytest
import pytest_asyncio
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.dialects.postgresql import ARRAY as PG_ARRAY
from sqlalchemy.engine import URL, make_url
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel import SQLModel

from database import get_session
from main import app
from tests.integration.pg_lane import (
    URL_ENV,
    IntegrationLaneMisconfiguredError,
    integration_database_name,
    resolve_integration_database_url,
)

_BACKEND_ROOT = Path(__file__).resolve().parents[2]
_ALEMBIC_INI = _BACKEND_ROOT / "alembic.ini"
_MIGRATIONS_DIR = _BACKEND_ROOT / "migrations"

# ``migrations/env.py`` overrides the config's URL from this variable, so it has
# to name the per-worker database while the upgrade runs.
_DATABASE_URL_ENV = "DATABASE_URL"

_POSTGRESQL_DIALECT = "postgresql"

_SKIP_REASON = f"{URL_ENV} is unset -- the Postgres integration lane needs a live server"

# Database names are interpolated into DDL that cannot take bind parameters, so
# they are constrained to an unambiguous identifier shape first.
_SAFE_IDENTIFIER = re.compile(r"[a-z0-9_]+")

# ``ARRAY`` columns as the models declare them, captured while the metadata is
# still pristine. Collection imports every conftest before any test body runs,
# so nothing has had the chance to rewrite them yet -- see
# :func:`_assert_array_columns_intact` for what this defends against.
_DECLARED_ARRAY_COLUMNS: frozenset[tuple[str, str]] = frozenset(
    (table.name, column.name)
    for table in SQLModel.metadata.tables.values()
    for column in table.columns
    if isinstance(column.type, PG_ARRAY)
)


def _current_array_columns() -> frozenset[tuple[str, str]]:
    """Return the ``(table, column)`` pairs currently typed as Postgres ARRAY."""
    return frozenset(
        (table.name, column.name)
        for table in SQLModel.metadata.tables.values()
        for column in table.columns
        if isinstance(column.type, PG_ARRAY)
    )


def _assert_array_columns_intact() -> None:
    """Fail if the SQLite fixture's ARRAY-to-JSON rewrite has already run.

    ``backend/conftest._replace_array_columns`` mutates ``SQLModel.metadata``
    process-globally. Against a real Postgres that would send a JSON string
    into a ``varchar[]`` column, and the resulting error would point at the
    model rather than at the fixture that broke it. The lane is selected by
    marker so no SQLite fixture should ever have run first, but "should" is
    not a guarantee worth betting a confusing failure on.

    Raises:
        IntegrationLaneMisconfiguredError: The declared ARRAY columns are
            missing, either because they were rewritten or because the snapshot
            itself was taken too late to mean anything.
    """
    lost = _DECLARED_ARRAY_COLUMNS - _current_array_columns()
    if _DECLARED_ARRAY_COLUMNS and not lost:
        return
    detail = sorted(f"{table}.{column}" for table, column in lost) or "no ARRAY column at all"
    msg = (
        f"SQLModel.metadata no longer declares {detail} as a Postgres ARRAY. A "
        "SQLite fixture rewrote the type to JSON in this process, which would "
        "corrupt every write the integration lane makes to a real Postgres."
    )
    raise IntegrationLaneMisconfiguredError(msg)


def _quoted_database_name(name: str) -> str:
    """Return ``name`` quoted for DDL, rejecting anything that is not an identifier.

    Raises:
        IntegrationLaneMisconfiguredError: ``name`` is not a bare lowercase
            identifier.
    """
    if not _SAFE_IDENTIFIER.fullmatch(name):
        msg = f"refusing to build DDL for the non-identifier database name {name!r}"
        raise IntegrationLaneMisconfiguredError(msg)
    return f'"{name}"'


async def _run_admin_statements(admin_url: URL, statements: tuple[str, ...]) -> None:
    """Execute DDL on the URL's own database with autocommit.

    ``CREATE`` / ``DROP DATABASE`` cannot run inside a transaction block, hence
    the AUTOCOMMIT isolation level and the pool-less engine.
    """
    engine = create_async_engine(admin_url, isolation_level="AUTOCOMMIT", poolclass=NullPool)
    try:
        async with engine.connect() as connection:
            for statement in statements:
                await connection.execute(text(statement))
    finally:
        await engine.dispose()


def _alembic_config(url: str) -> Config:
    """Return an alembic config pointed at ``url``.

    ``config_file_name`` is suppressed so ``env.py`` skips its ``fileConfig``
    call: loading ``alembic.ini``'s ``[loggers]`` section disables every logger
    created before it, which breaks ``caplog`` assertions in unrelated tests
    sharing the process.
    """
    config = Config(str(_ALEMBIC_INI))
    config.config_file_name = None
    config.set_main_option("script_location", str(_MIGRATIONS_DIR))
    config.set_main_option("sqlalchemy.url", url)
    return config


def _migrate_to_head(url: str) -> set[str]:
    """Build the schema at ``url`` from zero and return the script head revisions."""
    config = _alembic_config(url)
    command.upgrade(config, "head")
    return set(ScriptDirectory.from_config(config).get_heads())


async def _verify_provenance(url: str, heads: set[str]) -> None:
    """Assert the migrated database is Postgres and stamped at every script head.

    This is the tripwire for the lane silently degrading into something it was
    built to replace -- a SQLite fallback, or a schema that only partly
    migrated. The expected revisions come from the script directory, never from
    a literal, so adding a migration cannot leave this comparison stale.

    Raises:
        IntegrationLaneMisconfiguredError: The dialect is not Postgres, or the
            stamped revisions differ from the script heads.
    """
    engine = create_async_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as connection:
            dialect = connection.dialect.name
            result = await connection.execute(text("SELECT version_num FROM alembic_version"))
            stamped = set(result.scalars().all())
    finally:
        await engine.dispose()

    if dialect != _POSTGRESQL_DIALECT:
        msg = f"the integration lane connected to a {dialect!r} database, not Postgres"
        raise IntegrationLaneMisconfiguredError(msg)
    if stamped != heads:
        msg = (
            f"the integration database is stamped at {sorted(stamped)} but the "
            f"migration scripts head at {sorted(heads)}; the schema did not come "
            f"from a complete `alembic upgrade head`"
        )
        raise IntegrationLaneMisconfiguredError(msg)


@pytest.fixture(scope="session")
def pg_database_url() -> Iterator[str]:
    """Create, migrate and finally drop this worker's own database.

    Yields the URL of a database whose schema was built by
    ``alembic upgrade head`` from nothing. Deliberately synchronous: alembic
    drives its own ``asyncio.run``, which only works outside a running loop.

    The name disambiguates xdist workers within one run, not runs against each
    other. CI gives every job a private service container, but two concurrent
    local invocations pointed at one shared server would both claim
    ``adepthood_it_master`` and race on the CREATE/DROP -- give them distinct
    ``TEST_POSTGRES_URL`` servers rather than sharing one.
    """
    base = resolve_integration_database_url(os.environ)
    if base is None:
        pytest.skip(_SKIP_REASON)
    _assert_array_columns_intact()

    admin_url = make_url(base)
    name = integration_database_name(os.environ)
    quoted = _quoted_database_name(name)
    rendered = admin_url.set(database=name).render_as_string(hide_password=False)

    # FORCE terminates any connection a crashed earlier run left behind, so a
    # stale backend cannot turn the next run into an unexplained hang.
    drop = f"DROP DATABASE IF EXISTS {quoted} WITH (FORCE)"
    asyncio.run(_run_admin_statements(admin_url, (drop, f"CREATE DATABASE {quoted}")))
    try:
        with pytest.MonkeyPatch.context() as patch:
            patch.setenv(_DATABASE_URL_ENV, rendered)
            heads = _migrate_to_head(rendered)
        asyncio.run(_verify_provenance(rendered, heads))
        yield rendered
    finally:
        asyncio.run(_run_admin_statements(admin_url, (drop,)))


@pytest_asyncio.fixture
async def pg_engine(pg_database_url: str) -> AsyncGenerator[AsyncEngine, None]:
    """Yield an engine created inside the current test's event loop.

    Function-scoped because pytest-asyncio closes its loop after every test,
    and connections checked out under a closed loop raise "attached to a
    different loop". Creating an engine against a local Postgres costs
    milliseconds; the expensive part (migrating) already happened once.
    """
    engine = create_async_engine(pg_database_url, poolclass=NullPool)
    try:
        yield engine
    finally:
        await engine.dispose()


@pytest_asyncio.fixture
async def pg_session(pg_engine: AsyncEngine) -> AsyncGenerator[AsyncSession, None]:
    """Yield a session whose every write is rolled back when the test ends.

    The session joins an outer transaction through savepoints, so a router's
    ``commit()`` or ``begin_nested()`` behaves exactly as it does in production
    -- constraints fire, ``IntegrityError`` surfaces -- while the outer rollback
    still leaves the database untouched for the next test.

    ``expire_on_commit=False`` mirrors ``database.async_session_factory``, so
    handlers can keep reading attributes off an instance after committing it.
    """
    async with pg_engine.connect() as connection:
        transaction = await connection.begin()
        session = AsyncSession(
            bind=connection,
            join_transaction_mode="create_savepoint",
            expire_on_commit=False,
        )
        try:
            yield session
        finally:
            await session.close()
            await transaction.rollback()


@pytest_asyncio.fixture
async def pg_client(pg_session: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    """HTTP client driving the real app against the migrated Postgres.

    Handlers are given the *same* session the test holds, so a test can read
    back rows a request just committed and write rows a request will see.
    """

    async def _override_get_session() -> AsyncGenerator[AsyncSession, None]:
        yield pg_session

    app.dependency_overrides[get_session] = _override_get_session

    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
    finally:
        app.dependency_overrides.clear()
        assert not app.dependency_overrides, "dependency_overrides leaked between tests"
