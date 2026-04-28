"""Alembic environment: configures the async engine and target metadata.

The FastAPI app uses top-level absolute imports (``from database import ...``,
``from models import ...``) served from ``backend/src`` on ``PYTHONPATH``.  We
mirror that layout here so Alembic can import the same modules whether it's
invoked locally (``cd backend && alembic upgrade head``) or inside the
container (``WORKDIR=/app`` with ``PYTHONPATH=/app/src``).
"""

import asyncio
import os
import sys
from logging.config import fileConfig
from pathlib import Path
from typing import Any

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

# Make ``backend/src`` importable so ``import models`` / ``import database``
# resolve to the same modules the app uses at runtime.
_SRC = Path(__file__).resolve().parent.parent / "src"
if _SRC.is_dir() and str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from sqlmodel import SQLModel  # noqa: E402

import models  # noqa: E402, F401  (register tables on SQLModel.metadata)
from database import normalize_database_url  # noqa: E402

# Alembic Config object.
config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Inject the runtime DATABASE_URL so migrations run against the same database
# as the app.  Falls back to whatever is configured in alembic.ini (useful for
# ``alembic revision --autogenerate`` against a local dev database).
_db_url = os.getenv("DATABASE_URL")
if _db_url:
    config.set_main_option("sqlalchemy.url", normalize_database_url(_db_url))

target_metadata = SQLModel.metadata

# Indexes whose definitions use Postgres-specific SQL (functional, partial,
# or expression indexes) and are therefore created via raw ``op.execute`` in
# their own migrations.  They cannot be expressed in SQLModel column
# annotations without breaking the SQLite test fixture, so we tell
# autogenerate / ``alembic check`` to ignore them.  The migrations are the
# source of truth for these objects.
_RAW_SQL_MANAGED_INDEXES: frozenset[str] = frozenset(
    {
        # 78b1620cafde aside, every index here is created via op.execute
        # because SQLAlchemy's Index() can't render the expression on SQLite.
        "ix_user_lower_email_unique",  # e8376b41c6a1: lower(email)
        "ix_goal_completion_unique_per_day",  # d4e5f6a7b8c9: (timestamp AT TIME ZONE 'UTC')::date
        "ix_goal_completion_goal_user_timestamp",  # d4e5f6a7b8c9: composite
        "ix_user_practice_active_stage",  # f6a7b8c9d0e1: partial unique
    }
)

# Migration-internal archive tables created by dedup steps (see e.g.
# ``e1f2a3b4c5d6_contentcompletion_unique_user_content``).  These hold
# rows that were dropped to satisfy a freshly-added unique constraint
# and are intentionally not modeled in SQLModel — there is no router or
# RLS policy that exposes them.  We tell autogenerate / ``alembic check``
# to leave them alone so a successful ``upgrade head`` does not register
# as drift the next time the gate runs.
_MIGRATION_ARCHIVE_TABLE_PREFIX = "_duplicates_"


def _include_object(
    obj: Any,
    name: str | None,
    type_: str,
    reflected: bool,  # noqa: ARG001
    compare_to: Any,  # noqa: ARG001
) -> bool:
    """Skip raw-SQL-managed indexes and dedup archive tables.

    Without this, ``alembic check`` reports drift for every functional /
    partial index (see :data:`_RAW_SQL_MANAGED_INDEXES`) and for every
    ``_duplicates_*`` archive table left behind by a dedup migration.
    Both are migration-owned artifacts that the model layer
    intentionally does not declare.
    """
    if type_ == "index" and name in _RAW_SQL_MANAGED_INDEXES:
        return False
    if (
        type_ == "table"
        and name is not None
        and name.startswith(_MIGRATION_ARCHIVE_TABLE_PREFIX)
    ):
        return False
    return True


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode (emits SQL without a DBAPI)."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_object=_include_object,
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        include_object=_include_object,
    )

    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """Create an async Engine and associate a connection with the context."""
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
