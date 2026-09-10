"""Tests for ``GET /practice-sessions/stats`` — all-time per-practice totals.

Sibling of :mod:`tests.test_habit_stats_api`.  The aggregate answers "how much
have I put into *this* practice", so the interesting cases are the edges of the
population it sums over: which rows count (duration rule), which assignments
fan in (the same catalog practice adopted again at a later stage), and — above
all — which rows must never fan in (anybody else's).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.practice import Practice
from models.practice_session import PracticeSession
from models.user_practice import UserPractice

_STATS_URL = "/practice-sessions/stats"

_LONG_SIT = 45.0
_SHORT_SIT = 20.0
_SECOND_STAGE_SIT = 35.0
_OTHER_PRACTICE_SIT = 90.0
_INTRUDER_SIT = 600.0

_TWO_SITS = 2
_THREE_SITS = 3
_TWO_SITS_MINUTES = _LONG_SIT + _SHORT_SIT
_THREE_SITS_MINUTES = _TWO_SITS_MINUTES + _SECOND_STAGE_SIT
_LIVE_SESSION_MINUTES = 5.0


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Create a user and return (auth headers, user id)."""
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


async def _seed_practice(db_session: AsyncSession, name: str, stage_number: int = 1) -> Practice:
    """Insert a catalog practice row directly through the ORM."""
    practice = Practice(
        stage_number=stage_number,
        name=name,
        description="Sit quietly",
        instructions="Close your eyes and breathe",
        default_duration_minutes=10,
        approved=True,
    )
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)
    return practice


async def _adopt(
    db_session: AsyncSession, *, user_id: int, practice: Practice, stage_number: int = 1
) -> UserPractice:
    """Adopt ``practice`` for ``user_id`` at ``stage_number`` via the ORM.

    Written directly rather than through ``POST /user-practices/`` so a test can
    place a second adoption at a stage the user has not unlocked yet — the point
    being the *aggregate*, not the adoption gate.
    """
    adopted = UserPractice(
        user_id=user_id,
        practice_id=practice.id,
        stage_number=stage_number,
        start_date=datetime.now(UTC).date(),
    )
    db_session.add(adopted)
    await db_session.commit()
    await db_session.refresh(adopted)
    return adopted


async def _log(
    db_session: AsyncSession,
    *,
    user_id: int,
    user_practice: UserPractice,
    minutes: float,
    days_ago: int = 0,
) -> None:
    """Persist one session row of ``minutes`` against ``user_practice``."""
    db_session.add(
        PracticeSession(
            user_id=user_id,
            user_practice_id=user_practice.id,
            duration_minutes=minutes,
            timestamp=datetime.now(UTC) - timedelta(days=days_ago),
        )
    )
    await db_session.commit()


@pytest.mark.asyncio
async def test_stats_requires_auth(async_client: AsyncClient) -> None:
    """An anonymous caller never reaches the aggregate."""
    resp = await async_client.get(_STATS_URL, params={"user_practice_id": 1})

    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_stats_requires_the_user_practice_id(async_client: AsyncClient) -> None:
    """The aggregate is per practice: an unkeyed call is a 422, not a global total."""
    headers, _ = await _signup(async_client, "stats_unkeyed")

    resp = await async_client.get(_STATS_URL, headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_untouched_practice_reports_zeros(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An adopted-but-never-sat practice answers with zeros, not a 404."""
    headers, user_id = await _signup(async_client, "stats_zero")
    practice = await _seed_practice(db_session, "Stats Zero")
    adopted = await _adopt(db_session, user_id=user_id, practice=practice)

    resp = await async_client.get(
        _STATS_URL, params={"user_practice_id": adopted.id}, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == {"total_sessions": 0, "total_minutes": 0.0}


@pytest.mark.asyncio
async def test_totals_sum_the_practice_and_skip_zero_duration_aborts(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Two real sits count; a zero-length abort moves neither number.

    The duration rule is settled in :mod:`domain.practice_stats`; this pins that
    the endpoint actually applies it end to end rather than counting rows.
    """
    headers, user_id = await _signup(async_client, "stats_sum")
    practice = await _seed_practice(db_session, "Stats Sum")
    adopted = await _adopt(db_session, user_id=user_id, practice=practice)
    await _log(db_session, user_id=user_id, user_practice=adopted, minutes=_LONG_SIT)
    await _log(db_session, user_id=user_id, user_practice=adopted, minutes=_SHORT_SIT)
    await _log(db_session, user_id=user_id, user_practice=adopted, minutes=0.0)

    resp = await async_client.get(
        _STATS_URL, params={"user_practice_id": adopted.id}, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == {"total_sessions": _TWO_SITS, "total_minutes": _TWO_SITS_MINUTES}


@pytest.mark.asyncio
async def test_totals_span_every_adoption_of_the_same_practice(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Re-adopting a practice at a later stage does not reset its history.

    Each adoption is its own ``UserPractice`` row, so a total keyed strictly on
    the row the client named would show a practitioner who carried "Breath
    Counting" from stage 1 into stage 2 only the stage-2 slice — the exact
    number the user story says is wrong.  Either row must answer with the whole.
    """
    headers, user_id = await _signup(async_client, "stats_fanout")
    practice = await _seed_practice(db_session, "Stats Fanout")
    stage_one = await _adopt(db_session, user_id=user_id, practice=practice, stage_number=1)
    stage_two = await _adopt(db_session, user_id=user_id, practice=practice, stage_number=2)
    await _log(db_session, user_id=user_id, user_practice=stage_one, minutes=_LONG_SIT)
    await _log(db_session, user_id=user_id, user_practice=stage_one, minutes=_SHORT_SIT)
    await _log(db_session, user_id=user_id, user_practice=stage_two, minutes=_SECOND_STAGE_SIT)

    whole = {"total_sessions": _THREE_SITS, "total_minutes": _THREE_SITS_MINUTES}
    for named in (stage_one, stage_two):
        resp = await async_client.get(
            _STATS_URL, params={"user_practice_id": named.id}, headers=headers
        )
        assert resp.status_code == HTTPStatus.OK
        assert resp.json() == whole


@pytest.mark.asyncio
async def test_totals_exclude_the_users_other_practices(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The fan-out is scoped to one catalog practice, not to the whole account."""
    headers, user_id = await _signup(async_client, "stats_scope")
    practice = await _seed_practice(db_session, "Stats Scoped")
    other = await _seed_practice(db_session, "Stats Unrelated", stage_number=2)
    adopted = await _adopt(db_session, user_id=user_id, practice=practice)
    # A different stage, because ``userpractice`` is UNIQUE on
    # (user_id, stage_number): one live adoption per stage.
    unrelated = await _adopt(db_session, user_id=user_id, practice=other, stage_number=2)
    await _log(db_session, user_id=user_id, user_practice=adopted, minutes=_LONG_SIT)
    await _log(db_session, user_id=user_id, user_practice=unrelated, minutes=_OTHER_PRACTICE_SIT)

    resp = await async_client.get(
        _STATS_URL, params={"user_practice_id": adopted.id}, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == {"total_sessions": 1, "total_minutes": _LONG_SIT}


@pytest.mark.asyncio
async def test_stats_are_never_served_from_a_client_cache(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """No freshness lifetime, for the reason #2654 established for insights.

    The screen that reads this aggregate is reachable straight from the player
    that writes the rows it counts, so any positive ``max-age`` would let a
    browser answer the post-save re-read with the pre-save total out of its own
    HTTP cache.  There is no validator here to make revalidation cheap, and a
    total this cheap to recompute does not earn one.
    """
    headers, user_id = await _signup(async_client, "stats_cache")
    practice = await _seed_practice(db_session, "Stats Cache")
    adopted = await _adopt(db_session, user_id=user_id, practice=practice)

    resp = await async_client.get(
        _STATS_URL, params={"user_practice_id": adopted.id}, headers=headers
    )

    assert resp.headers["cache-control"] == "private, no-store"
    assert "max-age" not in resp.headers["cache-control"]
    assert resp.headers["vary"] == "Authorization"


@pytest.mark.asyncio
async def test_totals_move_the_moment_a_session_is_logged(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Read-after-write through the real write path, not a seeded row."""
    headers, user_id = await _signup(async_client, "stats_raw")
    practice = await _seed_practice(db_session, "Stats Read After Write")
    adopted = await _adopt(db_session, user_id=user_id, practice=practice)

    ended = datetime.now(UTC)
    created = await async_client.post(
        "/practice-sessions/",
        json={
            "user_practice_id": adopted.id,
            "started_at": (ended - timedelta(minutes=_LIVE_SESSION_MINUTES)).isoformat(),
            "ended_at": ended.isoformat(),
        },
        headers=headers,
    )
    assert created.status_code == HTTPStatus.CREATED

    resp = await async_client.get(
        _STATS_URL, params={"user_practice_id": adopted.id}, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == {"total_sessions": 1, "total_minutes": _LIVE_SESSION_MINUTES}


@pytest.mark.asyncio
async def test_another_users_sits_on_the_same_catalog_practice_never_fan_in(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The fan-out must be keyed on the caller as well as on the practice.

    Two people adopting the same preset is the ordinary case, not an exotic one,
    so a fan-out that resolved sibling adoptions by ``practice_id`` alone would
    quietly publish a stranger's practice history to everybody who adopted the
    same preset — with a 200 and no ownership error anywhere.  Asserted on the
    numbers rather than on a status code, because that leak *is* a 200.
    """
    alice_headers, alice_id = await _signup(async_client, "stats_alice")
    _, bob_id = await _signup(async_client, "stats_bob")
    shared = await _seed_practice(db_session, "Stats Shared Preset")
    alice_adopted = await _adopt(db_session, user_id=alice_id, practice=shared)
    bob_adopted = await _adopt(db_session, user_id=bob_id, practice=shared)
    await _log(db_session, user_id=alice_id, user_practice=alice_adopted, minutes=_SHORT_SIT)
    await _log(db_session, user_id=bob_id, user_practice=bob_adopted, minutes=_INTRUDER_SIT)

    resp = await async_client.get(
        _STATS_URL, params={"user_practice_id": alice_adopted.id}, headers=alice_headers
    )

    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == {"total_sessions": 1, "total_minutes": _SHORT_SIT}


@pytest.mark.parametrize("drift", ["foreign_owner", "foreign_adoption"])
@pytest.mark.asyncio
async def test_a_drifted_session_row_never_counts_in_either_direction(
    async_client: AsyncClient, db_session: AsyncSession, drift: str
) -> None:
    """Both halves of the scope are load-bearing, so neither may be dropped.

    ``PracticeSession`` carries ``user_id`` denormalized beside
    ``user_practice_id``, and the write path keeps the two in step — but a
    drifted row (a bad backfill, a restored dump) can disagree, and it can
    disagree in either direction:

    * ``foreign_owner`` — a row naming *another* user against an adoption the
      caller owns.  Scoping only the adoptions would count it in.
    * ``foreign_adoption`` — a row naming *the caller* against another user's
      adoption of the same catalog practice.  Scoping only the session rows
      would count it in, because the sibling fan-out would have collected that
      stranger's adoption.

    One case each, so dropping either predicate turns exactly one of these red
    rather than neither.  Seeded through the ORM because the drift is precisely
    what the API refuses to write.
    """
    alice_headers, alice_id = await _signup(async_client, f"stats_drift_a_{drift}")
    _, bob_id = await _signup(async_client, f"stats_drift_b_{drift}")
    practice = await _seed_practice(db_session, f"Stats Drifted {drift}")
    alice_adopted = await _adopt(db_session, user_id=alice_id, practice=practice)
    bob_adopted = await _adopt(db_session, user_id=bob_id, practice=practice)
    await _log(db_session, user_id=alice_id, user_practice=alice_adopted, minutes=_SHORT_SIT)

    if drift == "foreign_owner":
        await _log(db_session, user_id=bob_id, user_practice=alice_adopted, minutes=_INTRUDER_SIT)
    else:
        await _log(db_session, user_id=alice_id, user_practice=bob_adopted, minutes=_INTRUDER_SIT)

    resp = await async_client.get(
        _STATS_URL, params={"user_practice_id": alice_adopted.id}, headers=alice_headers
    )

    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == {"total_sessions": 1, "total_minutes": _SHORT_SIT}
