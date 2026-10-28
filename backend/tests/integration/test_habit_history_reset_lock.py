"""History resets share the PostgreSQL lock used by concurrent check-ins."""

from __future__ import annotations

import asyncio
from datetime import date
from http import HTTPStatus
from typing import TYPE_CHECKING

import pytest
from sqlalchemy import text
from sqlmodel import col, select

from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.goal_log_event import GoalLogEvent
from models.habit import Habit
from tests.helpers.feedback_triage import make_account

if TYPE_CHECKING:
    from httpx import Response
    from sqlalchemy.ext.asyncio import AsyncSession

    from tests.integration.session_per_request import SessionPerRequest

pytestmark = pytest.mark.integration

_LOCK_WAIT_SECONDS = 10


async def _wait_for_lock_or_response(
    session: AsyncSession, holder_pid: int, reset: asyncio.Task[Response]
) -> bool:
    """Observe a real database lock wait, rather than assuming a request started."""
    async with asyncio.timeout(_LOCK_WAIT_SECONDS):
        while not reset.done():
            # Activity snapshots are cached within a transaction. Refresh so
            # a request connection opened after the first poll is visible.
            await session.execute(text("SELECT pg_stat_clear_snapshot()"))
            blocked = await session.scalar(
                text(
                    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity "
                    "WHERE :pid = ANY(pg_blocking_pids(pid)))"
                ),
                {"pid": holder_pid},
            )
            if blocked:
                return True
            await asyncio.sleep(0.01)
    return False


@pytest.mark.asyncio
async def test_reset_waits_for_the_checkin_parent_lock(pair: SessionPerRequest) -> None:
    """A reset cannot race a log between its aggregate and event deletions."""
    async with pair.factory() as session:
        account = await make_account(session, "history-reset-lock@example.com")
        habit = Habit(
            user_id=account.user_id,
            name="Water",
            icon="*",
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
        habit_id, goal_id = habit.id, goal.id
    logged = await pair.client.post(
        "/goal_completions/",
        headers=account.headers,
        json={"goal_id": goal_id, "completed_units": 32},
    )
    assert logged.status_code == HTTPStatus.OK
    async with pair.factory() as holder:
        await holder.execute(select(Habit.id).where(Habit.id == habit_id).with_for_update())
        holder_pid = int((await holder.execute(text("SELECT pg_backend_pid()"))).scalar_one())
        reset = asyncio.create_task(
            pair.client.delete(f"/habits/{habit_id}/completions", headers=account.headers)
        )
        try:
            waiting = await _wait_for_lock_or_response(holder, holder_pid, reset)
        finally:
            await holder.rollback()
            response = await asyncio.wait_for(reset, timeout=_LOCK_WAIT_SECONDS)
    assert waiting, "history reset must acquire the same durable parent lock as a check-in"
    assert response.status_code == HTTPStatus.NO_CONTENT
    async with pair.factory() as session:
        assert (
            await session.scalar(
                select(GoalCompletion).where(col(GoalCompletion.goal_id) == goal_id)
            )
            is None
        )
        assert (
            await session.scalar(select(GoalLogEvent).where(col(GoalLogEvent.goal_id) == goal_id))
            is None
        )
