"""Tests for the user-practices API — selecting practices and viewing selections."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import select

from models.practice import Practice
from models.stage_progress import StageProgress
from models.user_practice import UserPractice

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
        "mode": "meditation_timer",
        "mode_config": {
            "mode": "meditation_timer",
            "duration_minutes": 10,
            "start_bell": True,
            "halfway_bell": False,
            "end_bell": True,
        },
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


# -- BUG-PRACTICE-005: single-active-practice TOCTOU --------------------------


@pytest.mark.asyncio
async def test_second_active_selection_replaces_prior(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Selecting a second practice for a stage replaces the first (BUG-PRACTICE-012).

    This is the "Replace this practice" / "Use for stage" flow. A
    sequential second pick must succeed, close the prior open row
    (``end_date`` set), and leave exactly one open row for the stage so
    the partial unique index invariant still holds. The earlier
    behaviour 409'd here, which made switching away from the seeded
    default impossible from the UI.
    """
    headers, user_id = await _signup(async_client, "doublepick")
    p1 = await _seed_practice(db_session, name="First")
    p2 = await _seed_practice(db_session, name="Second")

    first = await async_client.post(
        "/user-practices/",
        json={"practice_id": p1.id, "stage_number": 1},
        headers=headers,
    )
    assert first.status_code == HTTPStatus.CREATED

    second = await async_client.post(
        "/user-practices/",
        json={"practice_id": p2.id, "stage_number": 1},
        headers=headers,
    )
    assert second.status_code == HTTPStatus.CREATED
    assert second.json()["practice_id"] == p2.id
    assert second.json()["end_date"] is None

    # Exactly one open row, and it is the replacement; the prior pick is closed.
    rows = (
        (
            await db_session.execute(
                select(UserPractice).where(
                    UserPractice.user_id == user_id,
                    UserPractice.stage_number == 1,
                )
            )
        )
        .scalars()
        .all()
    )
    open_rows = [r for r in rows if r.end_date is None]
    assert len(open_rows) == 1
    assert open_rows[0].practice_id == p2.id
    closed = [r for r in rows if r.end_date is not None]
    assert [r.practice_id for r in closed] == [p1.id]


@pytest.mark.asyncio
async def test_reselecting_active_practice_is_noop(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Re-picking the already-active practice keeps the original row (BUG-PRACTICE-012).

    An accidental double-tap on the current selection must not open a
    fresh row or reset ``start_date`` -- the user-facing "I started
    this" label and the streak math that depends on it would otherwise
    silently reset.
    """
    headers, user_id = await _signup(async_client, "reselect")
    practice = await _seed_practice(db_session, name="Only")

    first = await async_client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": 1},
        headers=headers,
    )
    assert first.status_code == HTTPStatus.CREATED
    first_id = first.json()["id"]

    again = await async_client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": 1},
        headers=headers,
    )
    assert again.status_code == HTTPStatus.CREATED
    assert again.json()["id"] == first_id
    assert again.json()["start_date"] == first.json()["start_date"]

    rows = (
        (await db_session.execute(select(UserPractice).where(UserPractice.user_id == user_id)))
        .scalars()
        .all()
    )
    assert len(rows) == 1


_CONCURRENT_PICK_FANOUT = 5


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_concurrent_picks_for_same_stage_yield_one_open_row(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Five simultaneous selections for the same stage land exactly one open row.

    The partial unique index closes the BUG-PRACTICE-005 race: without
    it, concurrent SELECT-then-INSERT calls could each see "no open row"
    and both insert. The constraint guarantees the durable invariant
    asserted here -- exactly one open row -- regardless of timing.

    With the replace semantics (BUG-PRACTICE-012) the *response* mix is
    no longer "one 201, rest 409". Because every request targets the
    same practice, a request that observes the just-committed row treats
    re-selecting it as an idempotent no-op (201), while a request that
    raced ahead of that commit and lost the insert surfaces 409. Both
    are acceptable; what must never happen is a second *open* row or an
    unhandled 500. So we assert the durable invariant plus "every
    response is 201 or 409, and at least one succeeded".
    """
    signup_resp = await concurrent_async_client.post(
        "/auth/signup",
        json={
            "email": "racepick@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    headers = {"Authorization": f"Bearer {signup_resp.json()['token']}"}

    async with concurrent_session_factory() as session:
        practice = Practice(
            stage_number=1,
            name="RacePractice",
            description="x",
            instructions="y",
            default_duration_minutes=5,
            approved=True,
            mode="meditation_timer",
            mode_config={
                "mode": "meditation_timer",
                "duration_minutes": 5,
                "start_bell": True,
                "halfway_bell": False,
                "end_bell": True,
            },
        )
        session.add(practice)
        await session.commit()
        await session.refresh(practice)
        practice_id = practice.id

    responses = await asyncio.gather(
        *[
            concurrent_async_client.post(
                "/user-practices/",
                json={"practice_id": practice_id, "stage_number": 1},
                headers=headers,
            )
            for _ in range(_CONCURRENT_PICK_FANOUT)
        ]
    )

    status_codes = [r.status_code for r in responses]
    successes = status_codes.count(HTTPStatus.CREATED)
    conflicts = status_codes.count(HTTPStatus.CONFLICT)
    assert successes >= 1, f"expected at least one CREATED, got: {status_codes}"
    assert successes + conflicts == _CONCURRENT_PICK_FANOUT, (
        f"every response must be 201 or 409, got: {status_codes}"
    )

    async with concurrent_session_factory() as session:
        result = await session.execute(
            select(UserPractice).where(
                UserPractice.practice_id == practice_id,
                UserPractice.end_date.is_(None),  # type: ignore[union-attr]
            )
        )
        open_rows = list(result.scalars().all())
    assert len(open_rows) == 1


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_concurrent_switch_to_different_practices_yields_one_open_row(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Two simultaneous switches to DIFFERENT practices keep one open slot.

    Companion to the same-practice race above (issue #422, filed from the
    PR #409 verdict): here the requests target two different practices in
    the same stage slot, so the idempotent re-select path never applies.
    The partial unique index (``ix_user_practice_active_stage``) plus
    ``_free_stage_slot``'s close-before-insert must leave exactly one
    open row; the race loser gets the documented 409
    ``active_practice_exists_for_stage`` — never a 500, never a second
    open row.
    """
    signup_resp = await concurrent_async_client.post(
        "/auth/signup",
        json={
            "email": "raceswitch@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    headers = {"Authorization": f"Bearer {signup_resp.json()['token']}"}
    user_id = signup_resp.json()["user_id"]

    practice_ids: list[int] = []
    async with concurrent_session_factory() as session:
        for name in ("RaceSwitchA", "RaceSwitchB"):
            practice = Practice(
                stage_number=1,
                name=name,
                description="x",
                instructions="y",
                default_duration_minutes=5,
                approved=True,
                mode="meditation_timer",
                mode_config={
                    "mode": "meditation_timer",
                    "duration_minutes": 5,
                    "start_bell": True,
                    "halfway_bell": False,
                    "end_bell": True,
                },
            )
            session.add(practice)
            await session.commit()
            await session.refresh(practice)
            assert practice.id is not None
            practice_ids.append(practice.id)

    responses = await asyncio.gather(
        *[
            concurrent_async_client.post(
                "/user-practices/",
                json={"practice_id": practice_id, "stage_number": 1},
                headers=headers,
            )
            for practice_id in practice_ids
        ]
    )

    status_codes = sorted(r.status_code for r in responses)
    assert status_codes[0] == HTTPStatus.CREATED, f"expected a winner, got: {status_codes}"
    assert all(code in {HTTPStatus.CREATED, HTTPStatus.CONFLICT} for code in status_codes), (
        f"every response must be 201 or 409, got: {status_codes}"
    )
    for response in responses:
        if response.status_code == HTTPStatus.CONFLICT:
            assert response.json()["detail"] == "active_practice_exists_for_stage"

    async with concurrent_session_factory() as session:
        result = await session.execute(
            select(UserPractice).where(
                UserPractice.user_id == user_id,
                UserPractice.stage_number == 1,
                UserPractice.end_date.is_(None),  # type: ignore[union-attr]
            )
        )
        open_rows = list(result.scalars().all())
    assert len(open_rows) == 1
