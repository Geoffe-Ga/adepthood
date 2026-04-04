"""Tests for the practice sessions API — DB-backed with authentication."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.practice_session import PracticeSession


async def _signup(
    client: AsyncClient, username: str = "practitioner"
) -> tuple[dict[str, str], int]:
    """Create a user and return (auth headers, user_id)."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, data["user_id"]


def _session_payload(**overrides: object) -> dict[str, object]:
    """Return a valid practice session creation payload."""
    payload: dict[str, object] = {
        "practice_id": 2,
        "stage_number": 1,
        "duration_minutes": 5.0,
    }
    payload.update(overrides)
    return payload


# ── Unauthenticated access ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_session_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.post("/practice_sessions/", json=_session_payload())
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_week_count_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/practice_sessions/week_count")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ── Create session ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_session(async_client: AsyncClient) -> None:
    headers, _user_id = await _signup(async_client)
    payload = _session_payload(reflection="felt calm")
    resp = await async_client.post("/practice_sessions/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["reflection"] == payload["reflection"]
    assert data["practice_id"] == payload["practice_id"]
    assert data["stage_number"] == payload["stage_number"]
    assert data["duration_minutes"] == payload["duration_minutes"]
    assert data["id"] is not None
    assert data["user_id"] == _user_id


@pytest.mark.asyncio
async def test_create_session_without_reflection(async_client: AsyncClient) -> None:
    headers, _user_id = await _signup(async_client)
    resp = await async_client.post("/practice_sessions/", json=_session_payload(), headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["reflection"] is None


# ── Week count ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_week_count_returns_zero_when_empty(async_client: AsyncClient) -> None:
    headers, _user_id = await _signup(async_client)
    resp = await async_client.get("/practice_sessions/week_count", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["count"] == 0


@pytest.mark.asyncio
async def test_week_count_counts_current_week(async_client: AsyncClient) -> None:
    headers, _user_id = await _signup(async_client)
    # Create two sessions via the API
    await async_client.post("/practice_sessions/", json=_session_payload(), headers=headers)
    await async_client.post("/practice_sessions/", json=_session_payload(), headers=headers)
    resp = await async_client.get("/practice_sessions/week_count", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    expected_count = 2
    assert resp.json()["count"] == expected_count


@pytest.mark.asyncio
async def test_week_count_ignores_old_sessions(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client)
    # Insert an old session directly into DB (8 days ago)
    old_session = PracticeSession(
        user_id=user_id,
        practice_id=1,
        stage_number=1,
        duration_minutes=5.0,
        timestamp=datetime.now(UTC) - timedelta(days=8),
    )
    db_session.add(old_session)
    await db_session.commit()

    resp = await async_client.get("/practice_sessions/week_count", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["count"] == 0


# ── User isolation ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_week_count_scoped_to_user(async_client: AsyncClient) -> None:
    alice_headers, _alice_id = await _signup(async_client, "alice")
    bob_headers, _bob_id = await _signup(async_client, "bob")

    # Alice creates a session
    await async_client.post("/practice_sessions/", json=_session_payload(), headers=alice_headers)

    # Bob's count should be 0
    resp = await async_client.get("/practice_sessions/week_count", headers=bob_headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["count"] == 0
