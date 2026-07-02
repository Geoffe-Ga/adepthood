"""Tests for database engine, session management, and health endpoint."""

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from conftest import db_error_session, probe_via_session
from database import normalize_database_url


@pytest.mark.asyncio
async def test_health_returns_db_status(async_client: AsyncClient) -> None:
    """GET /health should confirm database connectivity."""
    response = await async_client.get("/health")
    assert response.status_code == HTTPStatus.OK
    data = response.json()
    assert data["status"] == "healthy"
    assert data["database"] == "connected"


@pytest.mark.asyncio
async def test_health_returns_503_when_db_unavailable() -> None:
    """GET /health returns 503 ``Database unavailable`` when the DB probe errors.

    Replaces the environment-dependent tautology that asserted
    ``status in (200, 503)`` (which passed whether or not a DB was reachable and
    checked nothing about the body): this drives the failure branch
    deterministically -- the probe's ``SELECT 1`` raises ``SQLAlchemyError`` --
    so a handler that returned 200 or swallowed the error would fail.
    """
    response = await probe_via_session("/health", db_error_session())
    assert response.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert response.json()["detail"] == "Database unavailable"


@pytest.mark.asyncio
async def test_get_session_yields_session(db_session: AsyncSession) -> None:
    """The test fixture should provide a working async session."""
    result = await db_session.execute(text("SELECT 1"))
    assert result.scalar() == 1


def test_normalize_database_url_adds_asyncpg_prefix() -> None:
    """Railway provides postgresql:// — we need postgresql+asyncpg://."""
    raw = "postgresql://user:pass@host:5432/dbname"  # pragma: allowlist secret
    assert (
        normalize_database_url(raw) == "postgresql+asyncpg://user:pass@host:5432/dbname"
    )  # pragma: allowlist secret


def test_normalize_database_url_preserves_asyncpg_prefix() -> None:
    """URLs already using asyncpg should remain unchanged."""
    raw = "postgresql+asyncpg://user:pass@host:5432/dbname"  # pragma: allowlist secret
    assert normalize_database_url(raw) == raw


def test_normalize_database_url_preserves_sqlite() -> None:
    """SQLite URLs for local dev/testing should pass through unchanged."""
    raw = "sqlite+aiosqlite:///:memory:"
    assert normalize_database_url(raw) == raw


def test_normalize_database_url_handles_postgres_shorthand() -> None:
    """Some providers use postgres:// instead of postgresql://."""
    raw = "postgres://user:pass@host:5432/dbname"  # pragma: allowlist secret
    assert (
        normalize_database_url(raw) == "postgresql+asyncpg://user:pass@host:5432/dbname"
    )  # pragma: allowlist secret


@pytest.mark.asyncio
async def test_tables_created_in_test_db(db_session: AsyncSession) -> None:
    """All SQLModel tables should exist in the test database."""
    result = await db_session.execute(
        text("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    )
    tables = {row[0] for row in result.fetchall()}
    assert "user" in tables
    assert "habit" in tables
    assert "goal" in tables
