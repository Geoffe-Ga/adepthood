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


def _iso_window(duration_minutes: float = _DEFAULT_DURATION) -> tuple[str, str]:
    """Return (started_at, ended_at) ISO strings spanning ``duration_minutes``.

    BUG-PRACTICE-006: clients must send ISO timestamps; the server derives
    ``duration_minutes``.  This helper encodes the canonical "just now"
    window so individual tests don't have to.
    """
    ended = datetime.now(UTC)
    started = ended - timedelta(minutes=duration_minutes)
    return started.isoformat(), ended.isoformat()


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


def _session_payload(
    user_practice_id: int,
    *,
    duration_minutes: float = _DEFAULT_DURATION,
    **overrides: object,
) -> dict[str, object]:
    """Return a valid practice session creation payload.

    Builds a fresh ``started_at`` / ``ended_at`` pair so each test exercises
    the server-derived duration path (BUG-PRACTICE-006).  ``duration_minutes``
    is a test-only knob used to size the window — it is *not* sent to the
    API.
    """
    started_at, ended_at = _iso_window(duration_minutes)
    payload: dict[str, object] = {
        "user_practice_id": user_practice_id,
        "started_at": started_at,
        "ended_at": ended_at,
    }
    payload.update(overrides)
    return payload


# -- Unauthenticated access -------------------------------------------------


@pytest.mark.asyncio
async def test_create_session_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.post("/practice-sessions/", json=_session_payload(1))
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_week_count_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/practice-sessions/week-count")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# -- Create session ----------------------------------------------------------


@pytest.mark.asyncio
async def test_create_session(async_client: AsyncClient, db_session: AsyncSession) -> None:
    headers, _user_id = await _signup(async_client)
    up_id = await _create_user_practice(async_client, db_session, headers)

    payload = _session_payload(up_id, reflection="felt calm")
    resp = await async_client.post("/practice-sessions/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["reflection"] == "felt calm"
    assert data["user_practice_id"] == up_id
    assert data["duration_minutes"] == _DEFAULT_DURATION
    assert data["id"] is not None
    # BUG-T7: response no longer echoes user_id (caller already knows from JWT).
    assert "user_id" not in data


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
        json=_session_payload(999),
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


# -- Server-derived duration / timestamp validation -------------------------
# BUG-PRACTICE-006, BUG-SCHEMA-008: clients send timestamps; the server
# computes duration and rejects out-of-range / legacy payloads with 422.


@pytest.mark.asyncio
async def test_create_session_rejects_legacy_duration_minutes(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A stale client that still sends ``duration_minutes`` is rejected loudly.

    Silent ignore would let the bug resurface invisibly on old builds, so the
    schema sets ``extra="forbid"``.
    """
    headers, _ = await _signup(async_client)
    up_id = await _create_user_practice(async_client, db_session, headers)
    payload = _session_payload(up_id, duration_minutes=10.0)
    payload["duration_minutes"] = 10.0

    resp = await async_client.post("/practice-sessions/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_create_session_requires_tz_aware_timestamps(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, _ = await _signup(async_client)
    up_id = await _create_user_practice(async_client, db_session, headers)
    naive_ended = datetime.now(UTC).replace(tzinfo=None)
    naive_started = naive_ended - timedelta(minutes=_DEFAULT_DURATION)
    resp = await async_client.post(
        "/practice-sessions/",
        json={
            "user_practice_id": up_id,
            "started_at": naive_started.isoformat(),
            "ended_at": naive_ended.isoformat(),
        },
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_create_session_rejects_inverted_window(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, _ = await _signup(async_client)
    up_id = await _create_user_practice(async_client, db_session, headers)
    started, ended = _iso_window()
    resp = await async_client.post(
        "/practice-sessions/",
        json={"user_practice_id": up_id, "started_at": ended, "ended_at": started},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_create_session_rejects_future_ended_at(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, _ = await _signup(async_client)
    up_id = await _create_user_practice(async_client, db_session, headers)
    ended = datetime.now(UTC) + timedelta(minutes=5)
    started = ended - timedelta(minutes=_DEFAULT_DURATION)
    resp = await async_client.post(
        "/practice-sessions/",
        json={
            "user_practice_id": up_id,
            "started_at": started.isoformat(),
            "ended_at": ended.isoformat(),
        },
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_create_session_rejects_backdated_started_at(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, _ = await _signup(async_client)
    up_id = await _create_user_practice(async_client, db_session, headers)
    started = datetime.now(UTC) - timedelta(hours=25)
    ended = started + timedelta(minutes=_DEFAULT_DURATION)
    resp = await async_client.post(
        "/practice-sessions/",
        json={
            "user_practice_id": up_id,
            "started_at": started.isoformat(),
            "ended_at": ended.isoformat(),
        },
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_create_session_rejects_unrealistic_duration(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, _ = await _signup(async_client)
    up_id = await _create_user_practice(async_client, db_session, headers)
    ended = datetime.now(UTC)
    started = ended - timedelta(hours=9)
    resp = await async_client.post(
        "/practice-sessions/",
        json={
            "user_practice_id": up_id,
            "started_at": started.isoformat(),
            "ended_at": ended.isoformat(),
        },
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_create_session_records_server_derived_duration(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Round-trip: client sends a 7-minute window, server stores ``7.0`` minutes."""
    headers, _ = await _signup(async_client)
    up_id = await _create_user_practice(async_client, db_session, headers)
    expected_minutes = 7.0
    started_at, ended_at = _iso_window(expected_minutes)
    resp = await async_client.post(
        "/practice-sessions/",
        json={
            "user_practice_id": up_id,
            "started_at": started_at,
            "ended_at": ended_at,
        },
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["duration_minutes"] == pytest.approx(expected_minutes)
    # ``timestamp`` is set to ``ended_at`` so week-count math anchors to when
    # the session actually finished.
    assert resp.json()["timestamp"].startswith(ended_at[:19])


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
