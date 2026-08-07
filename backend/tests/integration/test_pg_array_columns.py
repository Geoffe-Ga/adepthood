"""ARRAY-column behaviour that the SQLite lane rewrites to ``JSON`` and loses.

``backend/conftest.py`` swaps every ``ARRAY`` column to ``JSON()`` before
creating the SQLite schema, so the round-trip tests on the default lane prove
only that a list survives a JSON encode/decode. The assertions here are the
ones that JSON cannot satisfy: the server's own report of the stored type, and
array operators that are a type error against a JSON column.
"""

from __future__ import annotations

from datetime import date
from http import HTTPStatus
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from models.stage_progress import StageProgress

pytestmark = pytest.mark.integration

_HABIT_ICON = "🪷"
_HABIT_START = date(2024, 1, 1)
_HABIT_ENERGY_COST = 1
_HABIT_ENERGY_RETURN = 2
_NOTIFICATION_TIMES = ["08:00", "20:30"]
_NOTIFICATION_DAYS = ["mon", "wed"]
_COMPLETED_STAGES = [1, 2, 3]
_FIRST_STAGE = 1
_VARCHAR_ARRAY = "character varying[]"
_INTEGER_ARRAY = "integer[]"


async def _signup(client: AsyncClient, username: str) -> dict[str, str]:
    """Create a user and return its authorization headers."""
    response = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert response.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {response.json()['token']}"}


async def _user_id_for(session: AsyncSession, username: str) -> int:
    """Return the id of the user :func:`_signup` created for ``username``."""
    user_id = await session.scalar(
        text('SELECT id FROM "user" WHERE email = :email'),
        {"email": f"{username}@example.com"},
    )
    assert user_id is not None
    return int(user_id)


async def _create_notifying_habit(client: AsyncClient, headers: dict[str, str]) -> dict[str, Any]:
    """Create a habit carrying both notification arrays and return the response body."""
    payload = {
        "name": "Sit",
        "icon": _HABIT_ICON,
        "start_date": _HABIT_START.isoformat(),
        "energy_cost": _HABIT_ENERGY_COST,
        "energy_return": _HABIT_ENERGY_RETURN,
        "notification_times": _NOTIFICATION_TIMES,
        "notification_frequency": "daily",
        "notification_days": _NOTIFICATION_DAYS,
    }
    response = await client.post("/habits/", json=payload, headers=headers)
    assert response.status_code == HTTPStatus.OK
    body: dict[str, Any] = response.json()
    return body


async def _seed_stage_progress(client: AsyncClient, session: AsyncSession, username: str) -> int:
    """Sign a user up, give them a stage-progress row, and return their id."""
    await _signup(client, username)
    user_id = await _user_id_for(session, username)
    session.add(
        StageProgress(
            user_id=user_id,
            current_stage=_FIRST_STAGE,
            completed_stages=_COMPLETED_STAGES,
        )
    )
    await session.flush()
    return user_id


@pytest.mark.asyncio
async def test_notification_arrays_round_trip_unchanged(pg_client: AsyncClient) -> None:
    """Both notification arrays come back from ``GET`` exactly as they were written."""
    headers = await _signup(pg_client, "array-roundtrip")
    created = await _create_notifying_habit(pg_client, headers)

    fetched = await pg_client.get(f"/habits/{created['id']}", headers=headers)

    assert fetched.status_code == HTTPStatus.OK
    assert fetched.json()["notification_times"] == _NOTIFICATION_TIMES
    assert fetched.json()["notification_days"] == _NOTIFICATION_DAYS


@pytest.mark.asyncio
async def test_notification_days_is_stored_as_a_varchar_array(
    pg_client: AsyncClient, pg_session: AsyncSession
) -> None:
    """The server's own type report, not the client's decode, decides this.

    ``pg_typeof`` is answered by Postgres from the stored value, so a column
    that had silently become ``json`` or ``text`` fails here even though the
    HTTP round-trip above would still pass.
    """
    headers = await _signup(pg_client, "array-typeof")
    created = await _create_notifying_habit(pg_client, headers)

    column_type = await pg_session.scalar(
        text("SELECT pg_typeof(notification_days)::text FROM habit WHERE id = :habit_id"),
        {"habit_id": created["id"]},
    )

    assert column_type == _VARCHAR_ARRAY


@pytest.mark.asyncio
async def test_notification_days_answers_array_operators(
    pg_client: AsyncClient, pg_session: AsyncSession
) -> None:
    """``= ANY(...)`` and ``array_length`` run against the column and find the habit.

    Both are the assertions a JSON-backed column can never satisfy: against
    ``JSON`` they are an operator/type error rather than a wrong answer.
    """
    headers = await _signup(pg_client, "array-operators")
    created = await _create_notifying_habit(pg_client, headers)
    habit_id = created["id"]

    matched = await pg_session.scalar(
        text(
            "SELECT id FROM habit "
            "WHERE id = :habit_id AND CAST(:day AS varchar) = ANY(notification_days)"
        ),
        {"habit_id": habit_id, "day": _NOTIFICATION_DAYS[0]},
    )
    length = await pg_session.scalar(
        text("SELECT array_length(notification_days, 1) FROM habit WHERE id = :habit_id"),
        {"habit_id": habit_id},
    )

    assert matched == habit_id
    assert length == len(_NOTIFICATION_DAYS)


@pytest.mark.asyncio
async def test_completed_stages_is_stored_as_an_integer_array(
    pg_client: AsyncClient, pg_session: AsyncSession
) -> None:
    """``stageprogress.completed_stages`` is a NOT NULL ``integer[]``, not JSON."""
    user_id = await _seed_stage_progress(pg_client, pg_session, "array-stage-type")

    column_type = await pg_session.scalar(
        text(
            "SELECT pg_typeof(completed_stages)::text FROM stageprogress WHERE user_id = :user_id"
        ),
        {"user_id": user_id},
    )

    assert column_type == _INTEGER_ARRAY


@pytest.mark.asyncio
async def test_completed_stages_answers_array_operators(
    pg_client: AsyncClient, pg_session: AsyncSession
) -> None:
    """Membership and length hold for the integer array the same way."""
    user_id = await _seed_stage_progress(pg_client, pg_session, "array-stage-ops")

    matched = await pg_session.scalar(
        text(
            "SELECT user_id FROM stageprogress "
            "WHERE user_id = :user_id AND CAST(:stage AS integer) = ANY(completed_stages)"
        ),
        {"user_id": user_id, "stage": _COMPLETED_STAGES[-1]},
    )
    length = await pg_session.scalar(
        text(
            "SELECT array_length(completed_stages, 1) FROM stageprogress WHERE user_id = :user_id"
        ),
        {"user_id": user_id},
    )

    assert matched == user_id
    assert length == len(_COMPLETED_STAGES)
