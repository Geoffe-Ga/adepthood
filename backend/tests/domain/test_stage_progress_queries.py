"""Query-count regression tests for stage_progress aggregations.

The previous implementation issued ``1 + 2 * habits + goals`` queries per
``get_stage_habit_history`` call. Phase 7-04 collapses that to two queries
regardless of fan-out. These tests pin the query budget so a future
refactor cannot silently reintroduce N+1 behavior.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator, Iterator
from contextlib import contextmanager
from datetime import date

import pytest
import pytest_asyncio
from sqlalchemy import JSON, event
from sqlalchemy.dialects.postgresql import ARRAY as PG_ARRAY
from sqlalchemy.engine import Connection, ExecutionContext
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlmodel import SQLModel

from domain.stage_progress import get_stage_habit_history
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit

# Aggregation should be O(1) queries irrespective of habit/goal count.
_MAX_QUERIES_FOR_HABIT_HISTORY = 2

# Constants used by the seeded-history assertions, named so the assertions are
# self-documenting and ruff's PLR2004 stays satisfied.
_HABITS_SEEDED = 5
_GOALS_PER_HABIT = 3
_COMPLETIONS_PER_GOAL = 4
_EXPECTED_COMPLETIONS_PER_HABIT = _GOALS_PER_HABIT * _COMPLETIONS_PER_GOAL


def _replace_array_columns_for_sqlite() -> None:
    """SQLite cannot use PG ARRAY columns; swap them for JSON in tests."""
    for table in SQLModel.metadata.tables.values():
        for column in table.columns:
            if isinstance(column.type, PG_ARRAY):
                column.type = JSON()


@contextmanager
def _count_select_statements(engine: AsyncEngine) -> Iterator[list[str]]:
    """Yield a list whose length equals the number of SELECT statements run.

    Counting at the engine level is the most faithful measure: ORM lazy loads
    and explicit ``session.execute`` calls both surface here, so an N+1 cannot
    sneak past by switching loader strategy.
    """
    counter: list[str] = []

    def _before_cursor_execute(
        _conn: Connection,
        _cursor: object,
        statement: str,
        _params: object,
        _context: ExecutionContext,
        _executemany: bool,
    ) -> None:
        if statement.lstrip().upper().startswith("SELECT"):
            counter.append(statement)

    sync_engine = engine.sync_engine
    event.listen(sync_engine, "before_cursor_execute", _before_cursor_execute)
    try:
        yield counter
    finally:
        event.remove(sync_engine, "before_cursor_execute", _before_cursor_execute)


@pytest_asyncio.fixture
async def isolated_session() -> AsyncGenerator[tuple[AsyncSession, AsyncEngine], None]:
    """Provide a session bound to a fresh in-memory engine for query counting."""
    _replace_array_columns_for_sqlite()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)

    async with factory() as session:
        yield session, engine

    await engine.dispose()


async def _seed_habits_with_goals(
    session: AsyncSession,
    user_id: int,
    *,
    habit_count: int,
    goals_per_habit: int,
    completions_per_goal: int,
) -> None:
    """Insert habits, goals, and completions for a user in stage 1."""
    habits = [
        Habit(
            name=f"Habit {i}",
            icon="⭐",
            start_date=date(2026, 1, 1),
            energy_cost=1,
            energy_return=1,
            user_id=user_id,
            stage="1",
            streak=i,
        )
        for i in range(habit_count)
    ]
    session.add_all(habits)
    await session.commit()
    for h in habits:
        await session.refresh(h)

    goals = [
        Goal(
            habit_id=h.id,
            title=f"Goal {tier}",
            tier=tier,
            target=10,
            target_unit="reps",
            frequency=1,
            frequency_unit="per_day",
        )
        for h in habits
        for tier in [f"tier-{n}" for n in range(goals_per_habit)]
    ]
    session.add_all(goals)
    await session.commit()
    for g in goals:
        await session.refresh(g)

    completions = [
        GoalCompletion(goal_id=g.id, user_id=user_id, completed_units=10)
        for g in goals
        for _ in range(completions_per_goal)
    ]
    if completions:
        session.add_all(completions)
        await session.commit()


@pytest.mark.asyncio
async def test_habit_history_runs_in_constant_query_budget(
    isolated_session: tuple[AsyncSession, AsyncEngine],
) -> None:
    """Aggregation must not scale with habit or goal count."""
    session, engine = isolated_session
    user_id = 1
    await _seed_habits_with_goals(
        session,
        user_id,
        habit_count=_HABITS_SEEDED,
        goals_per_habit=_GOALS_PER_HABIT,
        completions_per_goal=_COMPLETIONS_PER_GOAL,
    )

    with _count_select_statements(engine) as queries:
        result = await get_stage_habit_history(session, user_id, stage_number=1)

    assert len(result) == _HABITS_SEEDED
    # Every habit should report total_completions = goals * completions per goal.
    assert all(item.total_completions == _EXPECTED_COMPLETIONS_PER_HABIT for item in result)
    # Every tier should be marked achieved (we wrote completions for every goal).
    assert all(all(item.goals_achieved.values()) for item in result)
    assert len(queries) <= _MAX_QUERIES_FOR_HABIT_HISTORY, (
        f"expected ≤{_MAX_QUERIES_FOR_HABIT_HISTORY} SELECTs, got {len(queries)}:\n"
        + "\n".join(queries)
    )


@pytest.mark.asyncio
async def test_habit_history_query_budget_unchanged_when_scaled(
    isolated_session: tuple[AsyncSession, AsyncEngine],
) -> None:
    """Doubling the fan-out must not increase query count."""
    session, engine = isolated_session
    user_id = 1
    await _seed_habits_with_goals(
        session,
        user_id,
        habit_count=_HABITS_SEEDED * 2,
        goals_per_habit=_GOALS_PER_HABIT + 2,
        completions_per_goal=_COMPLETIONS_PER_GOAL // 2,
    )

    with _count_select_statements(engine) as queries:
        await get_stage_habit_history(session, user_id, stage_number=1)

    assert len(queries) <= _MAX_QUERIES_FOR_HABIT_HISTORY, (
        f"expected ≤{_MAX_QUERIES_FOR_HABIT_HISTORY} SELECTs, got {len(queries)}:\n"
        + "\n".join(queries)
    )


@pytest.mark.asyncio
async def test_habit_history_marks_unachieved_goals_false(
    isolated_session: tuple[AsyncSession, AsyncEngine],
) -> None:
    """Goals with zero completions must still appear with ``False``."""
    session, _ = isolated_session
    user_id = 1
    await _seed_habits_with_goals(
        session,
        user_id,
        habit_count=1,
        goals_per_habit=2,
        completions_per_goal=0,
    )

    result = await get_stage_habit_history(session, user_id, stage_number=1)

    assert len(result) == 1
    assert result[0].total_completions == 0
    assert result[0].goals_achieved == {"tier-0": False, "tier-1": False}


@pytest.mark.asyncio
async def test_habit_history_only_counts_requesting_users_completions(
    isolated_session: tuple[AsyncSession, AsyncEngine],
) -> None:
    """Completions logged by another user must not leak into the aggregate."""
    session, _ = isolated_session
    owner_id, intruder_id = 1, 2

    habit = Habit(
        name="Mine",
        icon="🔒",
        start_date=date(2026, 1, 1),
        energy_cost=1,
        energy_return=1,
        user_id=owner_id,
        stage="1",
        streak=0,
    )
    session.add(habit)
    await session.commit()
    await session.refresh(habit)

    goal = Goal(
        habit_id=habit.id,
        title="Goal",
        tier="low",
        target=10,
        target_unit="reps",
        frequency=1,
        frequency_unit="per_day",
    )
    session.add(goal)
    await session.commit()
    await session.refresh(goal)

    # Intruder logs completions against the owner's goal — these must NOT
    # show up in the owner's aggregate.
    session.add_all(
        [
            GoalCompletion(goal_id=goal.id, user_id=intruder_id, completed_units=99),
            GoalCompletion(goal_id=goal.id, user_id=intruder_id, completed_units=99),
        ]
    )
    await session.commit()

    result = await get_stage_habit_history(session, owner_id, stage_number=1)

    assert len(result) == 1
    assert result[0].total_completions == 0
    assert result[0].goals_achieved == {"low": False}


@pytest.mark.asyncio
async def test_habit_history_is_empty_when_user_has_no_habits(
    isolated_session: tuple[AsyncSession, AsyncEngine],
) -> None:
    """No habits → returns ``[]`` without hitting the goal-stats query."""
    session, engine = isolated_session

    with _count_select_statements(engine) as queries:
        result = await get_stage_habit_history(session, user_id=1, stage_number=1)

    assert result == []
    # Only the habits SELECT should have been issued; no follow-up join.
    assert len(queries) == 1
