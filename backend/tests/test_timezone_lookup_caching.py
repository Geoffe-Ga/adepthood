"""Regression tests for issue #262 — one timezone lookup per request.

PR #260 threaded ``get_user_timezone`` through every endpoint that needs
the caller's IANA zone.  Each call is a cheap single-column PK SELECT, but
the pattern compounds across dependencies and helpers.  These tests pin the
contract that a request resolves the zone at most once: the duplicate
check-in path (the worst historical offender) and a representative
habit-stats read both stay at a single ``user.timezone`` SELECT.
"""

from __future__ import annotations

import re
from datetime import date
from http import HTTPStatus
from typing import TYPE_CHECKING

import pytest
from sqlalchemy import event

from conftest import test_engine
from models.goal import Goal
from models.habit import Habit

if TYPE_CHECKING:
    from collections.abc import Iterator

    from httpx import AsyncClient
    from sqlalchemy.ext.asyncio import AsyncSession

# Matches the single-column lookup rendered by
# ``select(User.timezone).where(User.id == ...)`` regardless of dialect
# quoting (`user.timezone` vs `"user".timezone`).
_TZ_SELECT = re.compile(r'SELECT\s+"?user"?\.timezone', re.IGNORECASE)


class _TimezoneSelectCounter:
    """Counts ``user.timezone`` SELECTs crossing the engine."""

    def __init__(self) -> None:
        self.count = 0

    def __call__(
        self,
        _conn: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        """SQLAlchemy ``before_cursor_execute`` hook: tally matching SELECTs."""
        if _TZ_SELECT.search(statement):
            self.count += 1


@pytest.fixture
def tz_select_counter() -> Iterator[_TimezoneSelectCounter]:
    """Attach a statement counter to the test engine for one test."""
    counter = _TimezoneSelectCounter()
    sync_engine = test_engine.sync_engine
    event.listen(sync_engine, "before_cursor_execute", counter)
    yield counter
    event.remove(sync_engine, "before_cursor_execute", counter)


async def _signup(client: AsyncClient, username: str = "tzcache") -> tuple[dict[str, str], int]:
    """Create a user and return ``(auth headers, user_id)``.

    Deliberately signs up with the default UTC zone: issue #412 documents a
    SQLite-only lexical-comparison bug that breaks non-UTC day-bounds
    queries (the duplicate check-in path misdetects for e.g.
    ``America/Los_Angeles``).  These tests pin lookup *counts*, which are
    zone-independent; switch to a non-UTC zone once #412 is fixed.
    """
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, int(data["user_id"])


async def _seed_goal(session: AsyncSession, user_id: int) -> Goal:
    """Create a habit + goal directly in the DB and return the goal."""
    habit = Habit(
        name="Meditation",
        icon="🧘",
        start_date=date(2025, 1, 1),
        energy_cost=10,
        energy_return=20,
        user_id=user_id,
    )
    session.add(habit)
    await session.commit()
    await session.refresh(habit)

    goal = Goal(
        habit_id=habit.id,
        title="Daily sit",
        tier="clear",
        target=10.0,
        target_unit="minutes",
        frequency=1.0,
        frequency_unit="per_day",
        is_additive=True,
    )
    session.add(goal)
    await session.commit()
    await session.refresh(goal)
    return goal


@pytest.mark.asyncio
async def test_duplicate_checkin_issues_at_most_one_timezone_lookup(
    async_client: AsyncClient,
    db_session: AsyncSession,
    tz_select_counter: _TimezoneSelectCounter,
) -> None:
    """The ``already_logged_today`` path resolves the zone at most once."""
    headers, user_id = await _signup(async_client)
    goal = await _seed_goal(db_session, user_id)

    first = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )
    assert first.status_code == HTTPStatus.OK

    tz_select_counter.count = 0
    duplicate = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )

    assert duplicate.status_code == HTTPStatus.OK
    assert duplicate.json()["reason_code"] == "already_logged_today"
    assert tz_select_counter.count <= 1


@pytest.mark.asyncio
async def test_habit_stats_issues_at_most_one_timezone_lookup(
    async_client: AsyncClient,
    db_session: AsyncSession,
    tz_select_counter: _TimezoneSelectCounter,
) -> None:
    """A habit-stats read resolves the zone at most once."""
    headers, user_id = await _signup(async_client)
    goal = await _seed_goal(db_session, user_id)

    tz_select_counter.count = 0
    resp = await async_client.get(f"/habits/{goal.habit_id}/stats", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert tz_select_counter.count <= 1
