"""Query-budget + parity tests for the batched ``list_stages`` progress (issue #473).

``list_stages`` used to call ``compute_stage_progress`` once per stage — an
N-by-M round-trip that scaled with course length on the most-visited screen.
``compute_stage_progress_batch`` collapses that to three grouped queries
regardless of stage count. These tests pin the query budget and prove the
batched values are identical to the per-stage loop they replace.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime

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

from domain.stage_progress import compute_stage_progress, compute_stage_progress_batch
from models.content_completion import ContentCompletion
from models.course_stage import CourseStage
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.practice import Practice
from models.practice_session import PracticeSession
from models.stage_content import StageContent
from models.user_practice import UserPractice

# The batch must issue exactly three grouped queries (habits, practice, course)
# no matter how many stages are requested.
_MAX_BATCH_QUERIES = 3
_USER_ID = 1


def _replace_array_columns_for_sqlite() -> None:
    """SQLite cannot use PG ARRAY columns; swap them for JSON in tests."""
    for table in SQLModel.metadata.tables.values():
        for column in table.columns:
            if isinstance(column.type, PG_ARRAY):
                column.type = JSON()


@contextmanager
def _count_select_statements(engine: AsyncEngine) -> Iterator[list[str]]:
    """Yield a list whose length equals the number of SELECT statements run."""
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
    """Session bound to a fresh in-memory engine so SELECTs can be counted."""
    _replace_array_columns_for_sqlite()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    async with factory() as session:
        yield session, engine
    await engine.dispose()


def _stage_fields(stage_number: int) -> dict[str, object]:
    return {
        "title": f"Stage {stage_number}",
        "subtitle": f"Subtitle {stage_number}",
        "stage_number": stage_number,
        "overview_url": f"https://example.com/stage-{stage_number}",
        "category": "test",
        "aspect": "test-aspect",
        "spiral_dynamics_color": "beige",
        "growing_up_stage": "archaic",
        "divine_gender_polarity": "masculine",
        "relationship_to_free_will": "active",
        "free_will_description": "Test description",
    }


@dataclass(frozen=True)
class _Activity:
    """Per-stage activity profile to seed (bundled so the seeder stays at ≤5 args)."""

    habits: int
    active_habits: int
    practice_sessions: int
    content_items: int


async def _seed_stage_activity(
    session: AsyncSession,
    stage_number: int,
    activity: _Activity,
) -> None:
    """Seed one stage with deterministic, per-stage-varying activity for user 1."""
    stage = CourseStage(**_stage_fields(stage_number))
    session.add(stage)
    await session.commit()
    await session.refresh(stage)

    for i in range(activity.habits):
        habit = Habit(
            name=f"H{stage_number}-{i}",
            icon="⭐",
            start_date=date(2026, 1, 1),
            energy_cost=1,
            energy_return=1,
            user_id=_USER_ID,
            stage=str(stage_number),
            streak=0,
        )
        session.add(habit)
        await session.commit()
        await session.refresh(habit)
        goal = Goal(
            habit_id=habit.id,
            title="g",
            tier="low",
            target=1,
            target_unit="reps",
            frequency=1,
            frequency_unit="per_day",
        )
        session.add(goal)
        await session.commit()
        await session.refresh(goal)
        if i < activity.active_habits:
            session.add(GoalCompletion(goal_id=goal.id, user_id=_USER_ID, completed_units=1))
            await session.commit()

    if activity.practice_sessions > 0:
        practice = Practice(
            stage_number=stage_number,
            name=f"P{stage_number}",
            description="d",
            instructions="x",
            default_duration_minutes=10,
        )
        session.add(practice)
        await session.commit()
        await session.refresh(practice)
        up = UserPractice(
            user_id=_USER_ID,
            practice_id=practice.id,
            stage_number=stage_number,
            start_date=date(2026, 1, 1),
        )
        session.add(up)
        await session.commit()
        await session.refresh(up)
        for _ in range(activity.practice_sessions):
            session.add(
                PracticeSession(
                    user_id=_USER_ID,
                    user_practice_id=up.id,
                    duration_minutes=10.0,
                    timestamp=datetime(2026, 3, 1, 10, 0, tzinfo=UTC),
                )
            )
        await session.commit()

    for j in range(activity.content_items):
        content = StageContent(
            course_stage_id=stage.id,
            title=f"C{stage_number}-{j}",
            content_type="essay",
            release_day=1,
            url=f"https://example.com/c{stage_number}-{j}",
        )
        session.add(content)
        await session.commit()
        await session.refresh(content)
        session.add(
            ContentCompletion(
                user_id=_USER_ID,
                content_id=content.id,
                completed_at=datetime(2026, 3, 1, tzinfo=UTC),
            )
        )
    await session.commit()


async def _seed_varied_stages(session: AsyncSession, stage_numbers: list[int]) -> None:
    """Give each stage a different activity profile so parity is non-trivial."""
    for n in stage_numbers:
        await _seed_stage_activity(
            session,
            n,
            _Activity(
                habits=(n % 3) + 1,
                active_habits=n % 2,
                practice_sessions=(n + 1) % 2,
                content_items=n % 3,
            ),
        )


@pytest.mark.asyncio
async def test_batch_issues_at_most_three_queries(
    isolated_session: tuple[AsyncSession, AsyncEngine],
) -> None:
    """The batch must run ≤3 SELECTs for many stages (no N+1)."""
    session, engine = isolated_session
    stages = [1, 2, 3, 4, 5]
    await _seed_varied_stages(session, stages)

    with _count_select_statements(engine) as queries:
        await compute_stage_progress_batch(session, _USER_ID, stages)

    assert len(queries) <= _MAX_BATCH_QUERIES, (
        f"expected ≤{_MAX_BATCH_QUERIES} SELECTs, got {len(queries)}:\n" + "\n".join(queries)
    )


@pytest.mark.asyncio
async def test_batch_query_count_is_constant_in_stage_count(
    isolated_session: tuple[AsyncSession, AsyncEngine],
) -> None:
    """Doubling the stage count must not increase the query count."""
    session, engine = isolated_session
    stages = list(range(1, 9))
    await _seed_varied_stages(session, stages)

    with _count_select_statements(engine) as small:
        await compute_stage_progress_batch(session, _USER_ID, stages[:3])
    with _count_select_statements(engine) as large:
        await compute_stage_progress_batch(session, _USER_ID, stages)

    assert len(small) == len(large)
    assert len(large) <= _MAX_BATCH_QUERIES


@pytest.mark.asyncio
async def test_batch_matches_per_stage_compute(
    isolated_session: tuple[AsyncSession, AsyncEngine],
) -> None:
    """Batched per-stage values must equal the old per-stage loop exactly."""
    session, _ = isolated_session
    stages = [1, 2, 3, 4, 5, 6]
    await _seed_varied_stages(session, stages)

    batch = await compute_stage_progress_batch(session, _USER_ID, stages)

    for n in stages:
        expected = await compute_stage_progress(session, _USER_ID, n)
        assert batch[n] == expected, f"stage {n}: {batch[n]} != {expected}"


@pytest.mark.asyncio
async def test_batch_empty_for_no_stages(
    isolated_session: tuple[AsyncSession, AsyncEngine],
) -> None:
    """An empty stage list short-circuits to an empty mapping (and no queries)."""
    session, engine = isolated_session
    with _count_select_statements(engine) as queries:
        result = await compute_stage_progress_batch(session, _USER_ID, [])
    assert result == {}
    assert len(queries) == 0
