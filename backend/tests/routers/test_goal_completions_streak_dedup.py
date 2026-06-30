"""A check-in must compute the consecutive streak at most once (audit §5.3).

The handler used to call ``compute_consecutive_streak`` in several branches of
the same request. It now derives the pre- and post-insert streak from a single
history read, so ``compute_consecutive_streak`` is invoked at most once per
request — while the persisted/response values stay identical, including the
backfill case where deriving from ``update_streak`` (old + 1) would be wrong.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

import services.checkin as checkin_module
from domain.dates import today_in_tz
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from services.streaks import PendingCompletion, StreakScope, SubtractiveContext


def _noon(day: date) -> datetime:
    """A tz-aware UTC timestamp at midday on ``day`` (unambiguous calendar bucket)."""
    return datetime.combine(day, datetime.min.time(), tzinfo=UTC) + timedelta(hours=12)


async def _signup(client: AsyncClient, username: str = "dedupuser") -> tuple[dict[str, str], int]:
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


async def _seed_goal(db_session: AsyncSession, user_id: int) -> Goal:
    habit = Habit(
        name="Meditation",
        icon="🧘",
        start_date=date(2025, 1, 1),
        energy_cost=10,
        energy_return=20,
        user_id=user_id,
    )
    db_session.add(habit)
    await db_session.commit()
    await db_session.refresh(habit)
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
    db_session.add(goal)
    await db_session.commit()
    await db_session.refresh(goal)
    return goal


async def _seed_completion(db_session: AsyncSession, goal: Goal, user_id: int, day: date) -> None:
    db_session.add(
        GoalCompletion(
            goal_id=goal.id, user_id=user_id, completed_units=goal.target, timestamp=_noon(day)
        )
    )
    await db_session.commit()


def _spy_streak_calls(monkeypatch: pytest.MonkeyPatch) -> tuple[list[int], list[int]]:
    """Count BOTH streak entry points so a regression on either path is caught.

    Returns ``(consecutive_calls, before_after_calls)``. The persist path uses
    ``compute_streak_before_and_after``; the held/idempotent paths use
    ``compute_consecutive_streak``. Spying only one would let a double-call on
    the other slip through.
    """
    consecutive = [0]
    before_after = [0]
    real_consecutive = checkin_module.compute_consecutive_streak
    real_before_after = checkin_module.compute_streak_before_and_after

    async def _count_consecutive(
        session: AsyncSession,
        goal_id: int,
        user_id: int,
        user_timezone: str = "UTC",
        subtractive: SubtractiveContext | None = None,
    ) -> int:
        consecutive[0] += 1
        return await real_consecutive(session, goal_id, user_id, user_timezone, subtractive)

    async def _count_before_after(
        session: AsyncSession, scope: StreakScope, pending: PendingCompletion
    ) -> tuple[int, int]:
        before_after[0] += 1
        return await real_before_after(session, scope, pending)

    monkeypatch.setattr(checkin_module, "compute_consecutive_streak", _count_consecutive)
    monkeypatch.setattr(checkin_module, "compute_streak_before_and_after", _count_before_after)
    return consecutive, before_after


@pytest.mark.asyncio
async def test_checkin_computes_streak_at_most_once(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A fresh check-in computes the streak exactly once (one combined read)."""
    headers, user_id = await _signup(async_client)
    goal = await _seed_goal(db_session, user_id)
    consecutive, before_after = _spy_streak_calls(monkeypatch)

    resp = await async_client.post(
        "/goal_completions/", json={"goal_id": goal.id, "did_complete": True}, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["streak"] == 1  # work still happened
    # Persist path: one combined read, no separate consecutive recompute.
    assert before_after[0] == 1
    assert consecutive[0] == 0


@pytest.mark.asyncio
async def test_idempotent_checkin_computes_streak_at_most_once(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A duplicate same-day check-in short-circuits with a single streak read."""
    headers, user_id = await _signup(async_client)
    goal = await _seed_goal(db_session, user_id)
    await async_client.post(
        "/goal_completions/", json={"goal_id": goal.id, "did_complete": True}, headers=headers
    )

    consecutive, before_after = _spy_streak_calls(monkeypatch)
    resp = await async_client.post(
        "/goal_completions/", json={"goal_id": goal.id, "did_complete": True}, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK
    # Idempotent path: one consecutive read, no persist-path combined read.
    assert consecutive[0] == 1
    assert before_after[0] == 0


@pytest.mark.asyncio
async def test_streak_value_parity_for_multiday_chain(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Checking in today on top of two prior days yields streak 3 (unchanged)."""
    headers, user_id = await _signup(async_client)
    goal = await _seed_goal(db_session, user_id)
    today = today_in_tz("UTC")
    await _seed_completion(db_session, goal, user_id, today - timedelta(days=1))
    await _seed_completion(db_session, goal, user_id, today - timedelta(days=2))

    resp = await async_client.post(
        "/goal_completions/", json={"goal_id": goal.id, "did_complete": True}, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["streak"] == 3


@pytest.mark.asyncio
async def test_backfill_streak_is_a_true_recompute_not_old_plus_one(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Backfilling the gap day bridges the chain to 2, proving a real recompute.

    The pre-backfill streak is a stale 0 (lone completion two days ago), so
    ``update_streak`` would have given old + 1 = 1; the correct recompute is 2.
    """
    headers, user_id = await _signup(async_client)
    goal = await _seed_goal(db_session, user_id)
    today = today_in_tz("UTC")
    await _seed_completion(db_session, goal, user_id, today - timedelta(days=2))

    resp = await async_client.post(
        "/goal_completions/",
        json={
            "goal_id": goal.id,
            "did_complete": True,
            "completed_on": (today - timedelta(days=1)).isoformat(),
        },
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["streak"] == 2
