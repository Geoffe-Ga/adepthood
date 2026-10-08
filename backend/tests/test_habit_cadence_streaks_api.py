"""A weekly habit's streak counts met weeks on every endpoint (#2819).

``GET /habits``, ``GET /habits/{id}``, ``GET /habits/{id}/stats`` and the
check-in response must agree: a rest day inside a three-sessions-a-week habit
does not break its streak, and the still-open week is grace.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from domain.dates import today_in_tz
from models.goal import Goal
from models.goal_completion import GoalCompletion

_SESSIONS_PER_WEEK = 3
_CLOSED_WEEKS_MET = 2
_DAYS_PER_WEEK = 7
_HABIT = {
    "name": "Lifting",
    "icon": "🏋️",
    "start_date": "2024-01-01",
    "energy_cost": 1,
    "energy_return": 2,
    "stage": "aptitude",
    "notification_times": ["08:00"],
    "notification_frequency": "daily",
    "notification_days": [],
    "milestone_notifications": True,
    "sort_order": 1,
}


async def _signup(client: AsyncClient) -> tuple[dict[str, str], int]:
    """Create a user and return (auth headers, user_id)."""
    resp = await client.post(
        "/auth/signup",
        json={"email": "lifter@example.com", "password": "secret12345"},  # pragma: allowlist secret
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, body["user_id"]


async def _weekly_habit(
    client: AsyncClient, session: AsyncSession, headers: dict[str, str]
) -> tuple[int, Goal]:
    """Create a habit, move its seeded ladder to 3x per week; return its clear tier."""
    resp = await client.post("/habits/", json=_HABIT, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    habit_id: int = resp.json()["id"]
    units = await client.put(
        f"/habits/{habit_id}/goals/units",
        json={
            "target_unit": "sessions",
            "frequency": _SESSIONS_PER_WEEK,
            "frequency_unit": "per_week",
        },
        headers=headers,
    )
    assert units.status_code == HTTPStatus.OK
    result = await session.execute(
        select(Goal).where(Goal.habit_id == habit_id, Goal.tier == "clear")
    )
    return habit_id, result.scalar_one()


def _seed_met_closed_weeks(session: AsyncSession, goal: Goal, user_id: int, today: date) -> None:
    """Meet the clear tier's weekly target in each of the last two closed weeks."""
    this_monday = today - timedelta(days=today.weekday())
    for weeks_back in range(1, _CLOSED_WEEKS_MET + 1):
        monday = this_monday - timedelta(days=_DAYS_PER_WEEK * weeks_back)
        for offset in range(_SESSIONS_PER_WEEK):
            day = monday + timedelta(days=offset)
            session.add(
                GoalCompletion(
                    goal_id=goal.id,
                    user_id=user_id,
                    local_day=day,
                    timestamp=datetime.combine(day, time(12), tzinfo=UTC),
                    completed_units=goal.target,
                )
            )


@pytest.mark.asyncio
async def test_weekly_streak_agrees_across_endpoints_and_survives_rest_days(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Two met weeks and an empty open week read as a two-week streak everywhere."""
    headers, user_id = await _signup(async_client)
    habit_id, clear_goal = await _weekly_habit(async_client, db_session, headers)
    _seed_met_closed_weeks(db_session, clear_goal, user_id, today_in_tz("UTC"))
    await db_session.commit()

    [listed] = (await async_client.get("/habits/", headers=headers)).json()
    detail = (await async_client.get(f"/habits/{habit_id}", headers=headers)).json()
    stats = (await async_client.get(f"/habits/{habit_id}/stats", headers=headers)).json()

    assert listed["streak"] == _CLOSED_WEEKS_MET
    assert detail["streak"] == _CLOSED_WEEKS_MET
    assert stats["current_streak"] == _CLOSED_WEEKS_MET
    assert stats["longest_streak"] == _CLOSED_WEEKS_MET

    # One session today leaves the open week unmet: still grace, not a break.
    check_in = await async_client.post(
        "/goal_completions/",
        json={"goal_id": clear_goal.id, "did_complete": True},
        headers=headers,
    )
    assert check_in.status_code == HTTPStatus.OK
    assert check_in.json()["streak"] == _CLOSED_WEEKS_MET

    # The amount-less replay reports the same period streak.
    replay = await async_client.post(
        "/goal_completions/",
        json={"goal_id": clear_goal.id, "did_complete": True},
        headers=headers,
    )
    assert replay.json()["reason_code"] == "already_logged_today"
    assert replay.json()["streak"] == _CLOSED_WEEKS_MET


@pytest.mark.asyncio
async def test_explicit_units_check_in_reports_the_period_streak(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Logging the open week's whole target turns it met and extends the streak."""
    headers, user_id = await _signup(async_client)
    _habit_id, clear_goal = await _weekly_habit(async_client, db_session, headers)
    _seed_met_closed_weeks(db_session, clear_goal, user_id, today_in_tz("UTC"))
    await db_session.commit()

    resp = await async_client.post(
        "/goal_completions/",
        json={
            "goal_id": clear_goal.id,
            "did_complete": True,
            "completed_units": clear_goal.target * _SESSIONS_PER_WEEK,
        },
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["streak"] == _CLOSED_WEEKS_MET + 1
