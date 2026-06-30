"""Tests for the completion-candidate gathering service (#816)."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date

import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from conftest import test_engine
from models.goal import Goal
from models.habit import Habit
from models.user import User
from services.completion_candidates import (
    MAX_CANDIDATES,
    gather_candidates,
    representative_goal,
)

_MAX_GATHER_QUERIES = 3  # habits + goals (selectinload) — constant in habit count


async def _user(session: AsyncSession, email: str = "cand@example.com") -> int:
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.commit()
    await session.refresh(user)
    assert user.id is not None
    return user.id


async def _habit(
    session: AsyncSession, user_id: int, name: str, *, tiers: tuple[str, ...]
) -> Habit:
    """Create a habit ``name`` with one goal per tier in ``tiers`` (in order)."""
    habit = Habit(
        name=name,
        icon="🧘",
        start_date=date(2025, 1, 1),
        energy_cost=1,
        energy_return=2,
        user_id=user_id,
    )
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    for tier in tiers:
        session.add(
            Goal(
                habit_id=habit.id,
                title=tier,
                tier=tier,
                target=1.0,
                target_unit="x",
                frequency=1.0,
                frequency_unit="per_day",
                is_additive=True,
            ),
        )
    await session.commit()
    await session.refresh(habit)
    return habit


async def _goal_id(session: AsyncSession, habit_id: int, tier: str) -> int:
    result = await session.execute(
        select(Goal.id).where(Goal.habit_id == habit_id, Goal.tier == tier),
    )
    gid = result.scalars().one()
    assert gid is not None
    return int(gid)


@contextmanager
def _count_selects() -> Iterator[list[str]]:
    """Count SELECT statements run against the shared test engine."""
    counter: list[str] = []

    def _before(
        _conn: object,
        _cursor: object,
        statement: str,
        _params: object,
        _context: object,
        _executemany: bool,  # SQLAlchemy event positional contract
    ) -> None:
        if statement.lstrip().upper().startswith("SELECT"):
            counter.append(statement)

    sync_engine = test_engine.sync_engine
    event.listen(sync_engine, "before_cursor_execute", _before)
    try:
        yield counter
    finally:
        event.remove(sync_engine, "before_cursor_execute", _before)


@pytest.mark.asyncio
async def test_clear_tier_goal_is_the_target(db_session: AsyncSession) -> None:
    user_id = await _user(db_session)
    habit = await _habit(db_session, user_id, "Meditate", tiers=("low", "clear", "stretch"))
    assert habit.id is not None
    clear_id = await _goal_id(db_session, habit.id, "clear")

    candidates = await gather_candidates(db_session, user_id)

    assert len(candidates) == 1
    assert candidates[0].target_id == clear_id
    assert candidates[0].target_type == "habit"
    assert candidates[0].name == "Meditate"
    assert candidates[0].index == 0


@pytest.mark.asyncio
async def test_first_goal_fallback_when_no_clear_tier(db_session: AsyncSession) -> None:
    user_id = await _user(db_session)
    habit = await _habit(db_session, user_id, "Stretch only", tiers=("low", "stretch"))
    assert habit.id is not None
    low_id = await _goal_id(db_session, habit.id, "low")

    candidates = await gather_candidates(db_session, user_id)

    assert len(candidates) == 1
    assert candidates[0].target_id == low_id  # first goal (lowest id), no clear tier


@pytest.mark.asyncio
async def test_goalless_habit_is_skipped(db_session: AsyncSession) -> None:
    user_id = await _user(db_session)
    await _habit(db_session, user_id, "Has goal", tiers=("clear",))
    await _habit(db_session, user_id, "No goals", tiers=())

    candidates = await gather_candidates(db_session, user_id)

    assert [c.name for c in candidates] == ["Has goal"]


@pytest.mark.asyncio
async def test_dense_indices_and_deterministic_order(db_session: AsyncSession) -> None:
    user_id = await _user(db_session)
    await _habit(db_session, user_id, "A", tiers=("clear",))
    await _habit(db_session, user_id, "B", tiers=("clear",))
    await _habit(db_session, user_id, "C", tiers=("clear",))

    candidates = await gather_candidates(db_session, user_id)

    assert [c.index for c in candidates] == [0, 1, 2]
    assert [c.name for c in candidates] == ["A", "B", "C"]  # habit-id order


@pytest.mark.asyncio
async def test_empty_when_no_habits(db_session: AsyncSession) -> None:
    user_id = await _user(db_session)
    assert await gather_candidates(db_session, user_id) == []


@pytest.mark.asyncio
async def test_caps_at_max_candidates_and_warns(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    user_id = await _user(db_session)
    for i in range(MAX_CANDIDATES + 2):
        await _habit(db_session, user_id, f"H{i:03d}", tiers=("clear",))

    with caplog.at_level(logging.WARNING):
        candidates = await gather_candidates(db_session, user_id)

    assert len(candidates) == MAX_CANDIDATES
    assert [c.index for c in candidates] == list(range(MAX_CANDIDATES))
    assert any("truncated" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_include_practices_is_dormant(db_session: AsyncSession) -> None:
    user_id = await _user(db_session)
    await _habit(db_session, user_id, "Only habit", tiers=("clear",))

    off = await gather_candidates(db_session, user_id, include_practices=False)
    on = await gather_candidates(db_session, user_id, include_practices=True)

    assert [c.name for c in on] == [c.name for c in off] == ["Only habit"]


@pytest.mark.asyncio
async def test_no_n_plus_one(db_session: AsyncSession) -> None:
    user_id = await _user(db_session)
    for i in range(5):
        await _habit(db_session, user_id, f"H{i}", tiers=("low", "clear"))

    with _count_selects() as queries:
        candidates = await gather_candidates(db_session, user_id)

    assert len(candidates) == 5
    assert len(queries) <= _MAX_GATHER_QUERIES, (
        f"expected <= {_MAX_GATHER_QUERIES} SELECTs (no N+1), got {len(queries)}"
    )


@pytest.mark.asyncio
async def test_representative_goal_standalone(db_session: AsyncSession) -> None:
    user_id = await _user(db_session)
    with_clear = await _habit(db_session, user_id, "WithClear", tiers=("low", "clear"))
    no_clear = await _habit(db_session, user_id, "NoClear", tiers=("low", "stretch"))
    goalless = await _habit(db_session, user_id, "Goalless", tiers=())
    assert with_clear.id is not None
    assert no_clear.id is not None

    clear_goal = await representative_goal(db_session, with_clear)
    first_goal = await representative_goal(db_session, no_clear)
    none_goal = await representative_goal(db_session, goalless)

    assert clear_goal is not None
    assert clear_goal.tier == "clear"
    assert first_goal is not None
    assert first_goal.tier == "low"  # first by id, no clear tier
    assert none_goal is None


@pytest.mark.asyncio
async def test_only_the_callers_habits(db_session: AsyncSession) -> None:
    mine = await _user(db_session, "mine@example.com")
    other = await _user(db_session, "other@example.com")
    await _habit(db_session, mine, "Mine", tiers=("clear",))
    await _habit(db_session, other, "Theirs", tiers=("clear",))

    candidates = await gather_candidates(db_session, mine)

    assert [c.name for c in candidates] == ["Mine"]
