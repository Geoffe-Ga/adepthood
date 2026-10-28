"""Execute the Habit Story event read against real goal log events."""

from datetime import UTC, datetime, time
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from domain.dates import today_in_tz
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.goal_log_event import GoalLogEvent
from models.habit import Habit
from tests.helpers.feedback_triage import make_account


async def _goal(session: AsyncSession, user_id: int) -> Goal:
    """A single owned goal is sufficient to test both query predicates."""
    habit = Habit(
        user_id=user_id,
        name="Water",
        icon="*",
        start_date=today_in_tz("UTC"),
        energy_cost=1,
        energy_return=2,
    )
    habit.goals = [
        Goal(
            title="Water",
            tier="clear",
            target=64,
            target_unit="oz",
            frequency=1,
            frequency_unit="per_day",
        )
    ]
    session.add(habit)
    await session.commit()
    return habit.goals[0]


@pytest.mark.asyncio
async def test_sql_projection_is_owned_stable_and_uncapped_for_patterns(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Latest200 of201 remains honest; foreign-scope events cannot leak into any rollup."""
    owner = await make_account(db_session, "story-event-owner@example.com")
    stranger = await make_account(db_session, "story-event-stranger@example.com")
    goal = await _goal(db_session, owner.user_id)
    foreign = await _goal(db_session, stranger.user_id)
    today = today_in_tz("UTC")
    moment = datetime.combine(today, time(6, 30), tzinfo=UTC)
    base = {
        "goal_id": goal.id,
        "user_id": owner.user_id,
        "timestamp": moment,
        "local_day": today,
        "via_timer": True,
        "source": "practice_link",
    }
    db_session.add_all(
        GoalLogEvent(**base, delta_units=-8 if index == 200 else 1) for index in range(201)
    )
    db_session.add_all(
        [
            GoalLogEvent(**{**base, "user_id": stranger.user_id}, delta_units=9999),
            GoalLogEvent(**{**base, "goal_id": foreign.id}, delta_units=9999),
        ]
    )
    db_session.add(
        GoalCompletion(goal_id=goal.id, user_id=owner.user_id, local_day=today, completed_units=256)
    )
    await db_session.commit()
    response = await async_client.get(f"/habits/{goal.habit_id}/story", headers=owner.headers)
    assert response.status_code == HTTPStatus.OK
    story = response.json()
    assert story["log_count"] == 201
    assert len(story["logs"]) == 200
    assert story["logs"][0]["delta_units"] == -8
    assert story["logs"][0]["timestamp"].endswith("Z")
    assert {log["source"] for log in story["logs"]} == {"practice_link"}
    assert all(log["via_timer"] for log in story["logs"])
    assert sum(map(sum, story["patterns"]["weekday_by_time_of_day"])) == 192
    assert story["patterns"]["unknown_time_units"] == 64
    assert story["days"][0]["unknown_time_units"] == 64
    assert story["patterns"]["time_of_day_available_since"] == today.isoformat()
