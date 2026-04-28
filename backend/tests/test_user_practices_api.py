"""Tests for the user-practices API — selecting practices and viewing selections."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.practice import Practice
from models.stage_progress import StageProgress

_EXPECTED_SELECTION_COUNT = 2
_SESSION_DURATION = 10.0


def _session_window(duration_minutes: float = _SESSION_DURATION) -> tuple[str, str]:
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


async def _seed_practice(db_session: AsyncSession, **overrides: object) -> Practice:
    """Insert a single approved practice and return it."""
    defaults: dict[str, object] = {
        "stage_number": 1,
        "name": "Meditation",
        "description": "Sit quietly",
        "instructions": "Close your eyes and breathe",
        "default_duration_minutes": 10,
        "approved": True,
    }
    defaults.update(overrides)
    practice = Practice(**defaults)
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)
    return practice


# -- Auth required ----------------------------------------------------------


@pytest.mark.asyncio
async def test_create_user_practice_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.post("/user-practices/", json={"practice_id": 1, "stage_number": 1})
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_list_user_practices_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/user-practices/")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# -- Select a practice (create user-practice) --------------------------------


@pytest.mark.asyncio
async def test_select_practice(async_client: AsyncClient, db_session: AsyncSession) -> None:
    headers, _user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)

    resp = await async_client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": 1},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    data = resp.json()
    # BUG-T7: user-practice responses no longer echo user_id.
    assert "user_id" not in data
    assert data["practice_id"] == practice.id
    assert data["stage_number"] == 1
    assert data["start_date"] is not None
    assert data["end_date"] is None


@pytest.mark.asyncio
async def test_select_unapproved_practice_rejected(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, _ = await _signup(async_client)
    practice = await _seed_practice(db_session, approved=False, name="Unapproved")

    resp = await async_client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": 1},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST


@pytest.mark.asyncio
async def test_select_nonexistent_practice_rejected(
    async_client: AsyncClient,
) -> None:
    headers, _ = await _signup(async_client)

    resp = await async_client.post(
        "/user-practices/",
        json={"practice_id": 999, "stage_number": 1},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


# -- BUG-PRACTICE-004: stage_number / practice stage consistency ------------


@pytest.mark.asyncio
async def test_select_practice_rejects_stage_mismatch(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """BUG-PRACTICE-004: payload.stage_number must equal practice.stage_number.

    Practice is catalogued for stage 2; client tries to enrol under stage 1.
    The server rejects the mismatch with 400 rather than silently letting a
    stage-2 practice count as stage-1 progress.
    """
    headers, _ = await _signup(async_client, "mismatch")
    practice = await _seed_practice(db_session, name="Stage2Practice", stage_number=2)

    resp = await async_client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": 1},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST
    assert resp.json()["detail"] == "stage_number_mismatch"


@pytest.mark.asyncio
async def test_select_practice_rejects_locked_stage(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """BUG-PRACTICE-004: user cannot enrol in a practice for a locked stage.

    Fresh user has no progress → stage 2 is locked.  Submitting a stage-2
    practice (catalog-consistent) must still 403 because the user has not
    completed stage 1.  Without this gate the chain-unlock invariant could
    be bypassed via the practice-enrolment surface.
    """
    headers, _ = await _signup(async_client, "lockedstage")
    practice = await _seed_practice(db_session, name="Stage2Practice", stage_number=2)

    resp = await async_client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": 2},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.FORBIDDEN
    assert resp.json()["detail"] == "stage_locked"


# -- List user-practices ----------------------------------------------------


@pytest.mark.asyncio
async def test_list_user_practices(async_client: AsyncClient, db_session: AsyncSession) -> None:
    headers, user_id = await _signup(async_client)
    p1 = await _seed_practice(db_session, name="P1", stage_number=1)
    p2 = await _seed_practice(db_session, name="P2", stage_number=2)
    # Unlock stage 2 so the second enrolment clears the BUG-PRACTICE-004 gate.
    db_session.add(StageProgress(user_id=user_id, current_stage=2, completed_stages=[1]))
    await db_session.commit()

    await async_client.post(
        "/user-practices/",
        json={"practice_id": p1.id, "stage_number": 1},
        headers=headers,
    )
    await async_client.post(
        "/user-practices/",
        json={"practice_id": p2.id, "stage_number": 2},
        headers=headers,
    )

    resp = await async_client.get("/user-practices/", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert len(data) == _EXPECTED_SELECTION_COUNT


@pytest.mark.asyncio
async def test_list_user_practices_scoped_to_user(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    alice_headers, _ = await _signup(async_client, "alice")
    bob_headers, _ = await _signup(async_client, "bob")
    practice = await _seed_practice(db_session)

    await async_client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": 1},
        headers=alice_headers,
    )

    resp = await async_client.get("/user-practices/", headers=bob_headers)
    assert resp.status_code == HTTPStatus.OK
    assert len(resp.json()) == 0


# -- Get single user-practice with session history --------------------------


@pytest.mark.asyncio
async def test_get_user_practice_with_sessions(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, _ = await _signup(async_client)
    practice = await _seed_practice(db_session)

    # Select the practice
    create_resp = await async_client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": 1},
        headers=headers,
    )
    up_id = create_resp.json()["id"]

    # Log a session against this user-practice
    started_at, ended_at = _session_window()
    await async_client.post(
        "/practice-sessions/",
        json={
            "user_practice_id": up_id,
            "started_at": started_at,
            "ended_at": ended_at,
        },
        headers=headers,
    )

    resp = await async_client.get(f"/user-practices/{up_id}", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["id"] == up_id
    assert len(data["sessions"]) == 1
    assert data["sessions"][0]["duration_minutes"] == _SESSION_DURATION


@pytest.mark.asyncio
async def test_get_user_practice_not_found(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client)
    resp = await async_client.get("/user-practices/999", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_get_other_users_practice_forbidden(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    alice_headers, _ = await _signup(async_client, "alice2")
    bob_headers, _ = await _signup(async_client, "bob2")
    practice = await _seed_practice(db_session)

    create_resp = await async_client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": 1},
        headers=alice_headers,
    )
    up_id = create_resp.json()["id"]

    resp = await async_client.get(f"/user-practices/{up_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN
