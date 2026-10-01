"""Weekly and monthly goals report streaks in whole periods, end to end.

A goal kept "3 a day, 4 days a week" used to be read by the client as 1.71 a
day and by the server as a daily chain. Now ``goal.target`` is the day's
amount, ``goal.frequency`` the done days a week needs, and every streak
surface -- ``POST /goal_completions/``, ``GET /habits/`` and
``GET /habits/{id}/stats`` -- counts complete Monday-to-Sunday weeks and says
so with ``streak_unit``.
"""

from __future__ import annotations

from datetime import date, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from domain.dates import today_in_tz
from domain.streaks import period_start
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit

_DAYS_PER_WEEK = 7
_DAY_TARGET = 3.0
_DAYS_NEEDED = 4.0
# (tier, per-day target): the ladder of a "sessions a day, four days a week" habit.
_WEEKLY_TIERS: tuple[tuple[str, float], ...] = (("low", 1.0), ("clear", 2.0), ("stretch", 3.0))


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}, resp.json()["user_id"]


async def _weekly_habit(db_session: AsyncSession, user_id: int) -> tuple[int, dict[str, int]]:
    """A habit whose three tiers are all kept four days a week; returns (habit id, goal ids)."""
    habit = Habit(
        name="Frequency Practice",
        icon="🔔",
        start_date=date(2025, 1, 1),
        energy_cost=1,
        energy_return=2,
        user_id=user_id,
        revealed=True,
    )
    db_session.add(habit)
    await db_session.commit()
    await db_session.refresh(habit)
    assert habit.id is not None
    goals = {
        tier: Goal(
            habit_id=habit.id,
            title=f"{tier} practice",
            tier=tier,
            target=target,
            target_unit="sessions",
            frequency=_DAYS_NEEDED,
            frequency_unit="per_week",
            is_additive=True,
        )
        for tier, target in _WEEKLY_TIERS
    }
    db_session.add_all(goals.values())
    await db_session.commit()
    for goal in goals.values():
        await db_session.refresh(goal)
    return habit.id, {tier: goal.id for tier, goal in goals.items() if goal.id is not None}


async def _log(
    db_session: AsyncSession, goal_id: int, user_id: int, day: date, units: float
) -> None:
    db_session.add(
        GoalCompletion(goal_id=goal_id, user_id=user_id, local_day=day, completed_units=units)
    )
    await db_session.commit()


async def _four_done_days_last_week(
    db_session: AsyncSession, goal_id: int, user_id: int, units: float = _DAY_TARGET
) -> date:
    """Seed Monday..Thursday of LAST week at ``units`` each; returns this week's Monday."""
    this_monday = period_start(today_in_tz("UTC"), "week")
    last_monday = this_monday - timedelta(days=_DAYS_PER_WEEK)
    for offset in range(int(_DAYS_NEEDED)):
        await _log(db_session, goal_id, user_id, last_monday + timedelta(days=offset), units)
    return this_monday


@pytest.mark.asyncio
async def test_a_check_in_on_a_weekly_goal_reports_weeks(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Last week complete, this week just begun: one week, in weeks."""
    headers, user_id = await _signup(async_client, "weekly_checkin")
    _, goals = await _weekly_habit(db_session, user_id)
    await _four_done_days_last_week(db_session, goals["low"], user_id)

    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goals["stretch"], "completed_units": 1},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body["streak_unit"] == "week"
    assert body["streak"] == 1
    assert body["day_units"] == 1


@pytest.mark.asyncio
async def test_a_daily_goal_still_reports_days(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client, "daily_checkin")
    habit_id, goals = await _weekly_habit(db_session, user_id)
    for goal_id in goals.values():
        goal = await db_session.get(Goal, goal_id)
        assert goal is not None
        goal.frequency_unit = "per_day"
        db_session.add(goal)
    await db_session.commit()

    resp = await async_client.post(
        "/goal_completions/", json={"goal_id": goals["low"], "completed_units": 1}, headers=headers
    )

    assert resp.json()["streak_unit"] == "day"
    assert resp.json()["streak"] == 1
    listed = await async_client.get("/habits/", headers=headers)
    assert [h["streak"] for h in listed.json() if h["id"] == habit_id] == [1]


@pytest.mark.asyncio
async def test_the_habit_list_counts_complete_weeks_at_the_low_tier(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A week counts once four of its days reach the LOW tier's day target."""
    headers, user_id = await _signup(async_client, "weekly_list")
    habit_id, goals = await _weekly_habit(db_session, user_id)
    this_monday = await _four_done_days_last_week(db_session, goals["low"], user_id, units=1.0)
    # Two done days this week: in progress, not a break.
    await _log(db_session, goals["low"], user_id, this_monday, 1.0)

    listed = await async_client.get("/habits/", headers=headers)

    [habit] = [h for h in listed.json() if h["id"] == habit_id]
    assert habit["streak"] == 1


@pytest.mark.asyncio
async def test_the_habit_list_does_not_count_a_week_of_short_days(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Four days at half the day target is four days of progress, not a week."""
    headers, user_id = await _signup(async_client, "weekly_short")
    habit_id, goals = await _weekly_habit(db_session, user_id)
    for goal_id in goals.values():
        goal = await db_session.get(Goal, goal_id)
        assert goal is not None
        goal.target = 2.0
        db_session.add(goal)
    await db_session.commit()
    await _four_done_days_last_week(db_session, goals["low"], user_id, units=1.0)

    listed = await async_client.get("/habits/", headers=headers)

    [habit] = [h for h in listed.json() if h["id"] == habit_id]
    assert habit["streak"] == 0


@pytest.mark.asyncio
async def test_stats_report_the_week_streak_and_its_unit(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client, "weekly_stats")
    habit_id, goals = await _weekly_habit(db_session, user_id)
    this_monday = await _four_done_days_last_week(db_session, goals["low"], user_id)
    two_weeks_ago = this_monday - timedelta(days=2 * _DAYS_PER_WEEK)
    for offset in range(int(_DAYS_NEEDED)):
        await _log(
            db_session, goals["low"], user_id, two_weeks_ago + timedelta(days=offset), _DAY_TARGET
        )

    resp = await async_client.get(f"/habits/{habit_id}/stats", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["streak_unit"] == "week"
    assert resp.json()["current_streak"] == 2
    assert resp.json()["longest_streak"] == 2
