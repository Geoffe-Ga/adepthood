"""Habit Story reads owned lifetime facts through the real HTTP and SQL seams."""

from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.dates import today_in_tz
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.stage_progress import StageProgress
from tests.helpers.feedback_triage import make_account


async def _habit(session: AsyncSession, user_id: int) -> Habit:
    """An old habit lets the read prove that the transport window is not reused."""
    habit = Habit(
        user_id=user_id,
        name="Pages",
        icon="*",
        start_date=today_in_tz("UTC") - timedelta(days=120),
        energy_cost=1,
        energy_return=2,
    )
    habit.goals = [
        Goal(
            title="Pages",
            tier="clear",
            target=2,
            target_unit="pages",
            frequency=1,
            frequency_unit="per_day",
        )
    ]
    session.add(habit)
    await session.commit()
    return habit


@pytest.mark.asyncio
async def test_story_loads_all_time_and_marks_unknown_recording_time(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A row older than the embedded-history window remains visible and untimed."""
    account = await make_account(db_session, "story-lifetime@example.com")
    habit = await _habit(db_session, account.user_id)
    today = today_in_tz("UTC")
    db_session.add_all(
        [
            GoalCompletion(
                goal_id=habit.goals[0].id,
                user_id=account.user_id,
                local_day=today - timedelta(days=100),
                completed_units=2,
            ),
            GoalCompletion(
                goal_id=habit.goals[0].id,
                user_id=account.user_id,
                local_day=today,
                completed_units=0,
            ),
        ]
    )
    await db_session.commit()
    response = await async_client.get(f"/habits/{habit.id}/story", headers=account.headers)
    assert response.status_code == HTTPStatus.OK
    story = response.json()
    assert response.headers["cache-control"] == "private, no-store"
    assert "authorization" in {
        value.strip().lower() for value in response.headers["vary"].split(",")
    }
    assert len(story["days"]) == 121
    assert story["logged_days"] == 2
    assert story["continuity"]["days_with"] == 1
    assert story["patterns"]["unknown_time_units"] == 2
    assert story["patterns"]["time_of_day_available_since"] is None
    assert story["logs"] == []
    assert story["log_count"] == 0
    assert story["days"][-1]["logged"] is True


@pytest.mark.asyncio
async def test_empty_and_missing_habits_have_distinct_responses(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A new empty record is valid history; an unknown habit is still missing."""
    account = await make_account(db_session, "story-empty@example.com")
    habit = await _habit(db_session, account.user_id)
    response = await async_client.get(f"/habits/{habit.id}/story", headers=account.headers)
    assert response.status_code == HTTPStatus.OK
    assert response.json()["logged_days"] == 0
    assert response.json()["continuity"]["current_run"] == 0
    assert (
        await db_session.scalar(
            select(StageProgress).where(col(StageProgress.user_id) == account.user_id)
        )
        is None
    )
    missing = await async_client.get("/habits/999999/story", headers=account.headers)
    assert missing.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_cross_owner_story_is_denied_before_reading_facts(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A predictable path id cannot expose another person's history."""
    owner = await make_account(db_session, "story-owner@example.com")
    stranger = await make_account(db_session, "story-stranger@example.com")
    habit = await _habit(db_session, owner.user_id)
    response = await async_client.get(f"/habits/{habit.id}/story", headers=stranger.headers)
    assert response.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_legacy_stage_start_is_not_a_known_program_anchor(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A later-stage timestamp must not fabricate Stage1 boundaries for a legacy account."""
    owner = await make_account(db_session, "story-unknown-anchor@example.com")
    habit = await _habit(db_session, owner.user_id)
    stage_start = datetime.now(UTC) - timedelta(days=10)
    progress = StageProgress(
        user_id=owner.user_id,
        current_stage=5,
        completed_stages=[1, 2, 3, 4],
        program_started_at=None,
        stage_started_at=stage_start,
    )
    db_session.add(progress)
    await db_session.commit()
    response = await async_client.get(f"/habits/{habit.id}/story", headers=owner.headers)
    assert response.status_code == HTTPStatus.OK
    assert response.json()["stages"] == []
    await db_session.refresh(progress)
    assert progress.program_started_at is None
    assert progress.current_stage == 5
    assert progress.stage_started_at.replace(tzinfo=UTC) == stage_start


@pytest.mark.asyncio
async def test_stored_program_anchor_supplies_the_actual_stage_boundaries(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A known program start supplies its own Stage1 date, not the current-stage start."""
    owner = await make_account(db_session, "story-known-anchor@example.com")
    habit = await _habit(db_session, owner.user_id)
    now = datetime.now(UTC)
    anchor = now - timedelta(days=50)
    db_session.add(
        StageProgress(
            user_id=owner.user_id,
            current_stage=5,
            completed_stages=[1, 2, 3, 4],
            program_started_at=anchor,
            stage_started_at=now - timedelta(days=10),
        )
    )
    await db_session.commit()
    response = await async_client.get(f"/habits/{habit.id}/story", headers=owner.headers)
    assert response.status_code == HTTPStatus.OK
    assert response.json()["stages"][0] == {
        "stage_number": 1,
        "opens_on": anchor.date().isoformat(),
        "closes_on": (anchor.date() + timedelta(days=20)).isoformat(),
    }
