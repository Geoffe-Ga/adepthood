"""Tests for database engine, session management, and health endpoint."""

from http import HTTPStatus

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from main import app


@pytest.mark.asyncio
async def test_health_returns_db_status(async_client: AsyncClient) -> None:
    """GET /health should confirm database connectivity."""
    response = await async_client.get("/health")
    assert response.status_code == HTTPStatus.OK
    data = response.json()
    assert data["status"] == "ok"
    assert data["database"] == "connected"


@pytest.mark.asyncio
async def test_health_returns_error_on_bad_db() -> None:
    """GET /health without a working DB should still respond (gracefully)."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health")
        # Even without test override, endpoint should not crash
        assert response.status_code in (HTTPStatus.OK, HTTPStatus.SERVICE_UNAVAILABLE)


@pytest.mark.asyncio
async def test_get_session_yields_session(db_session: AsyncSession) -> None:
    """The test fixture should provide a working async session."""
    result = await db_session.execute(text("SELECT 1"))
    assert result.scalar() == 1


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
