"""Tests for the practice sessions API — DB-backed with authentication."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.practice import Practice
from models.practice_session import PracticeSession

_DEFAULT_DURATION = 5.0
_EXPECTED_SESSION_COUNT = 2


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


async def _create_user_practice(
    async_client: AsyncClient,
    db_session: AsyncSession,
    headers: dict[str, str],
    *,
    stage_number: int = 1,
) -> int:
    """Seed a practice and select it, returning the user_practice id."""
    practice = Practice(
        stage_number=stage_number,
        name="Meditation",
        description="Sit quietly",
        instructions="Close your eyes and breathe",
        default_duration_minutes=10,
        approved=True,
    )
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)

    resp = await async_client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": stage_number},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    result: int = resp.json()["id"]
    return result


def _session_payload(user_practice_id: int, **overrides: object) -> dict[str, object]:
    """Return a valid practice session creation payload."""
    payload: dict[str, object] = {
        "user_practice_id": user_practice_id,
        "duration_minutes": _DEFAULT_DURATION,
    }
    payload.update(overrides)
    return payload


# -- Unauthenticated access -------------------------------------------------


@pytest.mark.asyncio
async def test_create_session_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.post(
        "/practice-sessions/",
        json={"user_practice_id": 1, "duration_minutes": _DEFAULT_DURATION},
    )
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_week_count_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/practice-sessions/week-count")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# -- Create session ----------------------------------------------------------


@pytest.mark.asyncio
async def test_create_session(async_client: AsyncClient, db_session: AsyncSession) -> None:
    headers, user_id = await _signup(async_client)
    up_id = await _create_user_practice(async_client, db_session, headers)

    payload = _session_payload(up_id, reflection="felt calm")
    resp = await async_client.post("/practice-sessions/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["reflection"] == "felt calm"
    assert data["user_practice_id"] == up_id
    assert data["duration_minutes"] == _DEFAULT_DURATION
    assert data["id"] is not None
    assert data["user_id"] == user_id


@pytest.mark.asyncio
async def test_create_session_without_reflection(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, _user_id = await _signup(async_client)
    up_id = await _create_user_practice(async_client, db_session, headers)

    resp = await async_client.post(
        "/practice-sessions/", json=_session_payload(up_id), headers=headers
    )
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["reflection"] is None


@pytest.mark.asyncio
async def test_create_session_invalid_user_practice(
    async_client: AsyncClient,
) -> None:
    headers, _ = await _signup(async_client)
    resp = await async_client.post(
        "/practice-sessions/",
        json={"user_practice_id": 999, "duration_minutes": _DEFAULT_DURATION},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_create_session_other_users_practice(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    alice_headers, _alice_id = await _signup(async_client, "alice")
    bob_headers, _ = await _signup(async_client, "bob")
    up_id = await _create_user_practice(async_client, db_session, alice_headers)

    resp = await async_client.post(
        "/practice-sessions/",
        json=_session_payload(up_id),
        headers=bob_headers,
    )
    assert resp.status_code == HTTPStatus.FORBIDDEN


# -- List sessions -----------------------------------------------------------


@pytest.mark.asyncio
async def test_list_sessions_by_user_practice(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, _user_id = await _signup(async_client)
    up_id = await _create_user_practice(async_client, db_session, headers)

    await async_client.post("/practice-sessions/", json=_session_payload(up_id), headers=headers)
    await async_client.post(
        "/practice-sessions/",
        json=_session_payload(up_id, duration_minutes=10.0),
        headers=headers,
    )

    resp = await async_client.get(
        "/practice-sessions/", params={"user_practice_id": up_id}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK
    assert len(resp.json()) == _EXPECTED_SESSION_COUNT


# -- Week count --------------------------------------------------------------


@pytest.mark.asyncio
async def test_week_count_returns_zero_when_empty(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client)
    resp = await async_client.get("/practice-sessions/week-count", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["count"] == 0


@pytest.mark.asyncio
async def test_week_count_counts_current_week(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, _user_id = await _signup(async_client)
    up_id = await _create_user_practice(async_client, db_session, headers)

    await async_client.post("/practice-sessions/", json=_session_payload(up_id), headers=headers)
    await async_client.post("/practice-sessions/", json=_session_payload(up_id), headers=headers)

    resp = await async_client.get("/practice-sessions/week-count", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["count"] == _EXPECTED_SESSION_COUNT


@pytest.mark.asyncio
async def test_week_count_ignores_old_sessions(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client)
    up_id = await _create_user_practice(async_client, db_session, headers)
    # Insert an old session directly into DB (8 days ago)
    old_session = PracticeSession(
        user_id=user_id,
        user_practice_id=up_id,
        duration_minutes=_DEFAULT_DURATION,
        timestamp=datetime.now(UTC) - timedelta(days=8),
    )
    db_session.add(old_session)
    await db_session.commit()

    resp = await async_client.get("/practice-sessions/week-count", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["count"] == 0


# -- User isolation ----------------------------------------------------------


@pytest.mark.asyncio
async def test_week_count_scoped_to_user(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    alice_headers, _alice_id = await _signup(async_client, "alice")
    bob_headers, _ = await _signup(async_client, "bob")
    up_id = await _create_user_practice(async_client, db_session, alice_headers)

    await async_client.post(
        "/practice-sessions/", json=_session_payload(up_id), headers=alice_headers
    )

    resp = await async_client.get("/practice-sessions/week-count", headers=bob_headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["count"] == 0
