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
    # BUG-PRACTICE-008: ``create_session`` now returns 201 to match the rest
    # of the POST contract; tests that asserted 200 captured the prior bug.
    assert resp.status_code == HTTPStatus.CREATED
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
    assert resp.status_code == HTTPStatus.CREATED
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
    assert resp.status_code == HTTPStatus.CREATED
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


# -- ritual-04: mode-aware metadata + insights ------------------------------


async def _create_typed_user_practice(
    async_client: AsyncClient,
    db_session: AsyncSession,
    headers: dict[str, str],
    *,
    mode: str = "rep_counter",
    stage_number: int = 1,
) -> tuple[int, Practice]:
    """Seed a non-default-mode practice and return ``(user_practice_id, practice)``."""
    mode_configs: dict[str, dict[str, object]] = {
        "rep_counter": {
            "mode": "rep_counter",
            "target_reps": 108,
            "unit_label": "breath cycles",
        },
        "metronome": {
            "mode": "metronome",
            "bpm": 72,
            "timer": {
                "mode": "meditation_timer",
                "duration_minutes": 10,
                "start_bell": True,
                "halfway_bell": False,
                "end_bell": True,
            },
        },
    }
    practice = Practice(
        stage_number=stage_number,
        name=f"{mode} practice",
        description="Test fixture",
        instructions="Test fixture",
        default_duration_minutes=10,
        approved=True,
        mode=mode,
        mode_config=mode_configs[mode],
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
    return int(resp.json()["id"]), practice


@pytest.mark.asyncio
async def test_create_session_persists_mode_metadata(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Rep-counter session round-trips its ``mode_metadata`` payload."""
    headers, _ = await _signup(async_client)
    up_id, _practice = await _create_typed_user_practice(async_client, db_session, headers)

    expected_rep_count = 42
    payload = _session_payload(
        up_id,
        mode_metadata={"mode": "rep_counter", "rep_count": expected_rep_count},
        insight="counted faster than yesterday",
    )
    resp = await async_client.post("/practice-sessions/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    body = resp.json()
    assert body["mode"] == "rep_counter"
    assert body["mode_metadata"] == {"mode": "rep_counter", "rep_count": expected_rep_count}
    assert body["insight"] == "counted faster than yesterday"
    assert body["completed"] is True


@pytest.mark.asyncio
async def test_create_session_records_partial_completion(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``completed=false`` with positive duration counts toward weekly totals."""
    headers, _ = await _signup(async_client)
    up_id = await _create_user_practice(async_client, db_session, headers)
    payload = _session_payload(up_id, completed=False)
    resp = await async_client.post("/practice-sessions/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    assert resp.json()["completed"] is False

    wk = await async_client.get("/practice-sessions/week-count", headers=headers)
    assert wk.status_code == HTTPStatus.OK
    assert wk.json()["count"] == 1


@pytest.mark.asyncio
async def test_create_session_rejects_mismatched_mode_metadata(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Sending ``rep_counter`` metadata against a meditation-timer practice → 400."""
    headers, _ = await _signup(async_client)
    up_id = await _create_user_practice(async_client, db_session, headers)
    payload = _session_payload(
        up_id,
        mode_metadata={"mode": "rep_counter", "rep_count": 10},
    )
    resp = await async_client.post("/practice-sessions/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.BAD_REQUEST
    assert resp.json()["detail"] == "mode_metadata_mismatch"


@pytest.mark.asyncio
async def test_create_session_rejects_invalid_metadata_payload(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A malformed metadata payload (BPM out of range) is rejected at 422."""
    headers, _ = await _signup(async_client)
    up_id, _ = await _create_typed_user_practice(
        async_client, db_session, headers, mode="metronome"
    )
    payload = _session_payload(
        up_id,
        mode_metadata={"mode": "metronome", "bpm_used": 0},
    )
    resp = await async_client.post("/practice-sessions/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_create_session_without_metadata_defaults_to_meditation_timer_mode(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Existing clients (no metadata) still get the resolved practice mode echoed."""
    headers, _ = await _signup(async_client)
    up_id = await _create_user_practice(async_client, db_session, headers)
    resp = await async_client.post(
        "/practice-sessions/", json=_session_payload(up_id), headers=headers
    )
    assert resp.status_code == HTTPStatus.CREATED
    body = resp.json()
    assert body["mode"] == "meditation_timer"
    assert body["mode_metadata"] is None
    assert body["insight"] is None
    assert body["completed"] is True


# -- ritual-04: insights endpoint -------------------------------------------


@pytest.mark.asyncio
async def test_insights_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/practice-sessions/insights")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_insights_empty_user_returns_empty_rollup(async_client: AsyncClient) -> None:
    """A user with no sessions still gets the full shape (8 zero buckets)."""
    headers, _ = await _signup(async_client)
    resp = await async_client.get("/practice-sessions/insights", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    expected_history_weeks = 8
    assert len(body["weekly_counts"]) == expected_history_weeks
    assert all(b["count"] == 0 for b in body["weekly_counts"])
    assert body["streak_weeks"] == 0
    assert body["total_minutes_30d"] == 0.0
    assert body["avg_duration_minutes_30d"] is None
    assert body["per_mode_counts"] == {}
    assert body["last_insight"] is None
    # Cache-Control is set so a chatty UI doesn't hammer the DB.
    assert resp.headers["cache-control"] == "private, max-age=60"


@pytest.mark.asyncio
async def test_insights_aggregates_recent_sessions(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A POST-driven smoke test: two rep-counter sessions land in the rollup."""
    headers, _ = await _signup(async_client)
    up_id, _ = await _create_typed_user_practice(async_client, db_session, headers)
    for reps in (10, 20):
        await async_client.post(
            "/practice-sessions/",
            json=_session_payload(
                up_id,
                mode_metadata={"mode": "rep_counter", "rep_count": reps},
                insight=f"reps={reps}",
            ),
            headers=headers,
        )

    resp = await async_client.get("/practice-sessions/insights", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    expected_session_count = 2
    assert body["per_mode_counts"] == {"rep_counter": expected_session_count}
    assert body["weekly_counts"][-1]["count"] == expected_session_count
    assert body["last_insight"] == "reps=20"


@pytest.mark.asyncio
async def test_insights_scoped_to_user(async_client: AsyncClient, db_session: AsyncSession) -> None:
    """Bob's insights must never see Alice's sessions."""
    alice_headers, _ = await _signup(async_client, "alice")
    bob_headers, _ = await _signup(async_client, "bob")
    up_id = await _create_user_practice(async_client, db_session, alice_headers)
    await async_client.post(
        "/practice-sessions/", json=_session_payload(up_id), headers=alice_headers
    )

    resp = await async_client.get("/practice-sessions/insights", headers=bob_headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["per_mode_counts"] == {}
    assert body["last_insight"] is None
