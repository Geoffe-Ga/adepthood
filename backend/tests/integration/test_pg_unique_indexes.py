"""Unique-index behaviour that only the migrated Postgres schema enforces.

Two of these constraints are functional / partial indexes the SQLite fixture
either approximates by hand or (for goal completions) deliberately omits from
``db_session``, so their database-level half runs unexercised on the default
lane. Each case is asserted twice: once through the HTTP contract, and once by
inserting straight through the session so the router's pre-check cannot be what
produces the pass.
"""

from __future__ import annotations

from datetime import date
from http import HTTPStatus
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import SQLModel

from models.goal_completion import GoalCompletion
from models.habit import Habit

pytestmark = pytest.mark.integration

_HABIT_ICON = "🪷"
_HABIT_START = date(2024, 1, 1)
_HABIT_ENERGY_COST = 1
_HABIT_ENERGY_RETURN = 2
_LOW_TIER = "low"
_COMPLETED_UNITS = 1.0


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
    """Return the id of the user :func:`_signup` created for ``username``.

    The habit response schema deliberately omits ``user_id`` -- the server owns
    it -- so a direct write has to look the owner up rather than echo it back.
    """
    user_id = await session.scalar(
        text('SELECT id FROM "user" WHERE email = :email'),
        {"email": f"{username}@example.com"},
    )
    assert user_id is not None
    return int(user_id)


def _habit_payload(name: str) -> dict[str, object]:
    """Return a minimal valid habit-creation payload under ``name``."""
    return {
        "name": name,
        "icon": _HABIT_ICON,
        "start_date": _HABIT_START.isoformat(),
        "energy_cost": _HABIT_ENERGY_COST,
        "energy_return": _HABIT_ENERGY_RETURN,
    }


async def _create_habit(client: AsyncClient, headers: dict[str, str], name: str) -> dict[str, Any]:
    """Create a habit (with its three default goals) and return the response body."""
    response = await client.post("/habits/", json=_habit_payload(name), headers=headers)
    assert response.status_code == HTTPStatus.OK
    body: dict[str, Any] = response.json()
    return body


def _low_tier_goal_id(habit: dict[str, Any]) -> int:
    """Return the id of the habit's auto-created low-tier goal."""
    for goal in habit["goals"]:
        if goal["tier"] == _LOW_TIER:
            return int(goal["id"])
    pytest.fail(f"habit {habit['id']} has no {_LOW_TIER}-tier goal")


async def _insert_in_savepoint(session: AsyncSession, row: SQLModel) -> None:
    """Flush ``row`` inside a savepoint so the caller's transaction survives a failure."""
    async with session.begin_nested():
        session.add(row)
        await session.flush()


@pytest.mark.asyncio
async def test_duplicate_normalized_habit_name_is_rejected_over_http(
    pg_client: AsyncClient,
) -> None:
    """A second habit differing only by case and surrounding space gets a 409."""
    headers = await _signup(pg_client, "habit-http")
    await _create_habit(pg_client, headers, "Sit")

    duplicate = await pg_client.post("/habits/", json=_habit_payload("  sit "), headers=headers)

    assert duplicate.status_code == HTTPStatus.CONFLICT
    assert duplicate.json()["detail"] == "duplicate_habit_name"


@pytest.mark.asyncio
async def test_habit_name_index_rejects_a_duplicate_that_bypasses_the_router(
    pg_client: AsyncClient, pg_session: AsyncSession
) -> None:
    """The migrated ``lower(trim(name))`` index rejects a direct insert.

    The HTTP test above passes on SQLite too, because ``_ensure_unique_name``
    catches it before the database is asked. Writing straight through the
    session removes that pre-check, leaving the index as the only thing that
    can produce the error -- which is the half the SQLite mirror only
    approximates.
    """
    username = "habit-index"
    headers = await _signup(pg_client, username)
    await _create_habit(pg_client, headers, "Sit")
    duplicate = Habit(
        user_id=await _user_id_for(pg_session, username),
        name="  sit ",
        icon=_HABIT_ICON,
        start_date=_HABIT_START,
        energy_cost=_HABIT_ENERGY_COST,
        energy_return=_HABIT_ENERGY_RETURN,
    )

    with pytest.raises(IntegrityError):
        await _insert_in_savepoint(pg_session, duplicate)


@pytest.mark.asyncio
async def test_second_check_in_on_the_same_day_stores_exactly_one_row(
    pg_client: AsyncClient, pg_session: AsyncSession
) -> None:
    """Re-checking in the same day is idempotent and leaves one completion row.

    The row count is the assertion that has teeth: a 200 with
    ``already_logged_today`` can be produced by the service's read-before-write
    fast path alone, whereas exactly one stored row is what the per-day unique
    index guarantees.
    """
    headers = await _signup(pg_client, "goal-idempotent")
    habit = await _create_habit(pg_client, headers, "Sit")
    goal_id = _low_tier_goal_id(habit)

    first = await pg_client.post("/goal_completions/", json={"goal_id": goal_id}, headers=headers)
    second = await pg_client.post("/goal_completions/", json={"goal_id": goal_id}, headers=headers)

    assert first.status_code == HTTPStatus.OK
    assert first.json()["reason_code"] != "already_logged_today"
    assert second.status_code == HTTPStatus.OK
    assert second.json()["reason_code"] == "already_logged_today"
    stored = await pg_session.scalar(
        text("SELECT count(*) FROM goalcompletion WHERE goal_id = :goal_id"),
        {"goal_id": goal_id},
    )
    assert stored == 1


@pytest.mark.asyncio
async def test_per_day_index_rejects_a_second_completion_for_the_same_local_day(
    pg_client: AsyncClient, pg_session: AsyncSession
) -> None:
    """``ix_goal_completion_unique_per_day`` rejects a direct duplicate insert.

    ``backend/conftest.py`` omits this index from the default ``db_session``
    fixture, so on the SQLite lane nothing exercises the database-level half of
    the ``IntegrityError -> already_logged_today`` path at all.
    """
    headers = await _signup(pg_client, "goal-index")
    habit = await _create_habit(pg_client, headers, "Sit")
    goal_id = _low_tier_goal_id(habit)
    await pg_client.post("/goal_completions/", json={"goal_id": goal_id}, headers=headers)
    result = await pg_session.execute(
        text("SELECT user_id, local_day FROM goalcompletion WHERE goal_id = :goal_id"),
        {"goal_id": goal_id},
    )
    logged = result.one()
    duplicate = GoalCompletion(
        goal_id=goal_id,
        user_id=logged.user_id,
        local_day=logged.local_day,
        completed_units=_COMPLETED_UNITS,
    )

    with pytest.raises(IntegrityError):
        await _insert_in_savepoint(pg_session, duplicate)
