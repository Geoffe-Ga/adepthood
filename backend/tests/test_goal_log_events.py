"""Check-in events are actual changes, not requests or reconstructed history."""

from datetime import UTC, date, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.dates import today_in_tz
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.goal_log_event import GoalLogEvent
from models.habit import Habit
from tests.helpers.feedback_triage import make_account


async def _goal(session: AsyncSession, user_id: int) -> Goal:
    """Give an account one daily unit goal."""
    habit = Habit(
        user_id=user_id,
        name="Water",
        icon="💧",
        start_date=date(2026, 1, 1),
        energy_cost=1,
        energy_return=2,
    )
    session.add(habit)
    await session.flush()
    goal = Goal(
        habit_id=habit.id,
        title="Water",
        tier="clear",
        target=64,
        target_unit="oz",
        frequency=1,
        frequency_unit="per_day",
    )
    session.add(goal)
    await session.commit()
    return goal


async def _events(session: AsyncSession) -> list[GoalLogEvent]:
    """Read the append-only sequence in write order."""
    return list(
        (await session.execute(select(GoalLogEvent).order_by(col(GoalLogEvent.id)))).scalars()
    )


@pytest.mark.asyncio
async def test_explicit_logs_keep_each_actual_change(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Two logs and a clamped undo preserve all three actual deltas."""
    account = await make_account(db_session, "water-events")
    goal = await _goal(db_session, account.user_id)
    for amount in (32, 32, -100, -10, 0):
        response = await async_client.post(
            "/goal_completions/",
            headers=account.headers,
            json={"goal_id": goal.id, "completed_units": amount, "did_complete": amount != 0},
        )
        assert response.status_code == HTTPStatus.OK
    events = await _events(db_session)
    assert [event.delta_units for event in events] == [32, 32, -64]
    assert {event.source for event in events} == {"manual"}
    assert {event.local_day for event in events} == {today_in_tz("UTC")}


@pytest.mark.asyncio
async def test_legacy_repeats_and_keyed_replays_append_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Neither natural-key no-ops nor spent signed operations duplicate history."""
    account = await make_account(db_session, "replay-events")
    goal = await _goal(db_session, account.user_id)
    for _ in range(2):
        response = await async_client.post(
            "/goal_completions/", headers=account.headers, json={"goal_id": goal.id}
        )
        assert response.status_code == HTTPStatus.OK
    for _ in range(2):
        response = await async_client.post(
            "/goal_completions/",
            headers={**account.headers, "Idempotency-Key": "one-operation"},
            json={"goal_id": goal.id, "completed_units": 4},
        )
        assert response.status_code == HTTPStatus.OK
    assert [event.delta_units for event in await _events(db_session)] == [64, 4]


@pytest.mark.asyncio
async def test_correction_across_tiers_records_one_actual_operation(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A correction keeps its origin even when it consumes another tier's units."""
    account = await make_account(db_session, "tier-events")
    clear = await _goal(db_session, account.user_id)
    low = Goal(**{**clear.model_dump(exclude={"id"}), "tier": "low", "target": 32})
    db_session.add(low)
    await db_session.commit()
    for goal, amount in ((clear, 32), (low, 32), (low, -60)):
        response = await async_client.post(
            "/goal_completions/",
            headers=account.headers,
            json={"goal_id": goal.id, "completed_units": amount},
        )
        assert response.status_code == HTTPStatus.OK
    events = await _events(db_session)
    assert [event.delta_units for event in events] == [32, 32, -60]
    assert events[-1].goal_id == low.id
    assert response.json()["day_units"] == 4


@pytest.mark.asyncio
async def test_unknown_source_is_rejected_before_writing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The additive metadata field accepts only the bounded source enum."""
    account = await make_account(db_session, "invalid-events")
    goal = await _goal(db_session, account.user_id)
    response = await async_client.post(
        "/goal_completions/",
        headers=account.headers,
        json={"goal_id": goal.id, "source": "unknown"},
    )
    assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert await _events(db_session) == []
    assert (await db_session.execute(select(GoalCompletion))).scalars().all() == []


@pytest.mark.asyncio
async def test_backfill_records_now_and_the_requested_local_day(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The event's audit timestamp never borrows the aggregate's historical noon."""
    account = await make_account(db_session, "backfill-events")
    goal = await _goal(db_session, account.user_id)
    past = today_in_tz("UTC") - timedelta(days=3)
    started = datetime.now(UTC)
    response = await async_client.post(
        "/goal_completions/",
        headers=account.headers,
        json={"goal_id": goal.id, "completed_on": past.isoformat(), "via_timer": True},
    )
    assert response.status_code == HTTPStatus.OK
    event = (await _events(db_session))[0]
    assert event.local_day == past
    assert event.timestamp.replace(tzinfo=UTC) >= started
    assert event.via_timer is True
    assert event.source == "timer"


@pytest.mark.asyncio
async def test_practice_link_source_is_distinct_from_timer_provenance(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The optional practice seam names its source without changing old requests."""
    account = await make_account(db_session, "practice-events")
    goal = await _goal(db_session, account.user_id)
    response = await async_client.post(
        "/goal_completions/",
        headers=account.headers,
        json={
            "goal_id": goal.id,
            "completed_units": 20,
            "source": "practice_link",
            "via_timer": True,
        },
    )
    assert response.status_code == HTTPStatus.OK
    event = (await _events(db_session))[0]
    assert (event.source, event.via_timer, event.delta_units) == ("practice_link", True, 20)


@pytest.mark.asyncio
async def test_existing_day_rows_are_not_backfilled(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Repeating a pre-event aggregate leaves its unknown logging time unknown."""
    account = await make_account(db_session, "historical-events")
    goal = await _goal(db_session, account.user_id)
    db_session.add(GoalCompletion(goal_id=goal.id, user_id=account.user_id, completed_units=64))
    await db_session.commit()
    response = await async_client.post(
        "/goal_completions/", headers=account.headers, json={"goal_id": goal.id}
    )
    assert response.status_code == HTTPStatus.OK
    assert await _events(db_session) == []


@pytest.mark.asyncio
async def test_export_carries_only_the_owners_events(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Per-log history is portable through the existing account archive."""
    owner = await make_account(db_session, "export-events")
    other = await make_account(db_session, "other-events")
    goal_ids = {}
    for account in (owner, other):
        goal = await _goal(db_session, account.user_id)
        goal_ids[account.user_id] = goal.id
        response = await async_client.post(
            "/goal_completions/", headers=account.headers, json={"goal_id": goal.id}
        )
        assert response.status_code == HTTPStatus.OK
    response = await async_client.get("/users/me/export", headers=owner.headers)
    assert response.status_code == HTTPStatus.OK
    exported = response.json()["records"]["goal_log_events"]
    assert len(exported) == 1
    assert exported[0]["goal_id"] == goal_ids[owner.user_id]
    assert exported[0]["delta_units"] == 64
