import sys
from collections.abc import AsyncGenerator
from pathlib import Path

# Absolute path to the repo root (directory that contains 'backend')
REPO_ROOT = (Path(__file__).parent / "..").resolve()

# Add backend/src to sys.path — must happen before importing app modules
sys.path.insert(0, str(REPO_ROOT / "backend/src"))

import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import JSON  # noqa: E402
from sqlalchemy.dialects.postgresql import ARRAY as PG_ARRAY  # noqa: E402
from sqlalchemy.ext.asyncio import (  # noqa: E402
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlmodel import SQLModel  # noqa: E402

import models as _models  # noqa: E402, F401
from database import get_session  # noqa: E402
from main import app  # noqa: E402

# ---------------------------------------------------------------------------
# Test database: SQLite in-memory (no external services needed)
# ---------------------------------------------------------------------------
TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"

test_engine = create_async_engine(TEST_DATABASE_URL, echo=False)
test_session_factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)


def _replace_array_columns() -> None:
    """Swap PostgreSQL ARRAY columns to JSON for SQLite compatibility."""
    for table in SQLModel.metadata.tables.values():
        for column in table.columns:
            if isinstance(column.type, PG_ARRAY):
                column.type = JSON()


@pytest_asyncio.fixture
async def db_session() -> AsyncGenerator[AsyncSession, None]:
    """Provide a clean async session with all tables created."""
    _replace_array_columns()

    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)

    async with test_session_factory() as session:
        yield session

    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.drop_all)


@pytest_asyncio.fixture
async def async_client(db_session: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    """HTTP client with database dependency overridden to use test DB."""

    async def _override_get_session() -> AsyncGenerator[AsyncSession, None]:
        yield db_session

    app.dependency_overrides[get_session] = _override_get_session

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client

    app.dependency_overrides.clear()
