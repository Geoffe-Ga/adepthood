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


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode (emits SQL without a DBAPI)."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)

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
