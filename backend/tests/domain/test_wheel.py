"""Domain tests for the Wheel of Wholeness pure function: compute_wheel_balance."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from datetime import UTC, date, datetime

import pytest
import pytest_asyncio
from sqlalchemy import JSON
from sqlalchemy.dialects.postgresql import ARRAY as PG_ARRAY
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel, col, select

from domain.stage_progress import compute_stage_progress_batch
from domain.wheel import compute_wheel_balance
from models.content_completion import ContentCompletion
from models.course_stage import CourseStage
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.practice import Practice
from models.practice_session import PracticeSession
from models.stage_content import StageContent
from models.user_practice import UserPractice

# Synthetic aspect labels for the fixture rows, in stage_number order; these
# are local test values, not the canonical seed ontology from seed_stages.py.
_CANONICAL_ASPECTS = [
    "Body",  # stage 1
    "Body",  # stage 2
    "Emotion",  # stage 3
    "Emotion",  # stage 4
    "Mind",  # stage 5
    "Mind",  # stage 6
    "Spirit",  # stage 7
    "Spirit",  # stage 8
    "Nondual",  # stage 9
    "Nondual",  # stage 10
]

_TOTAL_STAGES = 10
_USER_A = 1
_USER_B = 2


def _replace_array_columns_for_sqlite() -> None:
    """Swap PG ARRAY columns to JSON for SQLite test compatibility."""
    for table in SQLModel.metadata.tables.values():
        for column in table.columns:
            if isinstance(column.type, PG_ARRAY):
                column.type = JSON()


@pytest_asyncio.fixture
async def session() -> AsyncGenerator[AsyncSession, None]:
    """In-memory SQLite session, schema created fresh per test."""
    _replace_array_columns_for_sqlite()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    async with factory() as s:
        yield s
    await engine.dispose()


async def _seed_course_stage(s: AsyncSession, stage_number: int) -> CourseStage:
    """Insert a CourseStage row so FK constraints and queries resolve."""
    cs = CourseStage(
        title=f"Stage {stage_number}",
        subtitle="sub",
        stage_number=stage_number,
        overview_url="",
        category="test",
        aspect=_CANONICAL_ASPECTS[stage_number - 1],
        spiral_dynamics_color="beige",
        growing_up_stage="archaic",
        divine_gender_polarity="masculine",
        relationship_to_free_will="active",
        free_will_description="desc",
    )
    s.add(cs)
    await s.commit()
    await s.refresh(cs)
    return cs


async def _seed_all_course_stages(s: AsyncSession) -> list[CourseStage]:
    """Insert all ten CourseStage rows."""
    return [await _seed_course_stage(s, n) for n in range(1, _TOTAL_STAGES + 1)]


async def _seed_habit_with_completion(s: AsyncSession, user_id: int, stage_number: int) -> None:
    """Seed one habit with one goal and one completion for the given stage."""
    habit = Habit(
        name=f"H-stage{stage_number}-user{user_id}",
        icon="x",
        start_date=date(2026, 1, 1),
        energy_cost=1,
        energy_return=1,
        user_id=user_id,
        stage=str(stage_number),
        streak=0,
    )
    s.add(habit)
    await s.commit()
    await s.refresh(habit)
    goal = Goal(
        habit_id=habit.id,
        title="g",
        tier="t",
        target=1,
        target_unit="rep",
        frequency=1,
        frequency_unit="per_day",
    )
    s.add(goal)
    await s.commit()
    await s.refresh(goal)
    s.add(GoalCompletion(goal_id=goal.id, user_id=user_id, completed_units=1))
    await s.commit()


async def _seed_practice_with_session(s: AsyncSession, user_id: int, stage_number: int) -> None:
    """Seed a practice selection and one logged session for the given stage."""
    practice = Practice(
        stage_number=stage_number,
        name=f"P-{stage_number}-{user_id}",
        description="d",
        instructions="i",
        default_duration_minutes=5.0,
        approved=True,
    )
    s.add(practice)
    await s.commit()
    await s.refresh(practice)
    up = UserPractice(
        user_id=user_id,
        practice_id=practice.id,
        stage_number=stage_number,
        start_date=date(2026, 1, 1),
    )
    s.add(up)
    await s.commit()
    await s.refresh(up)
    s.add(
        PracticeSession(
            user_id=user_id,
            user_practice_id=up.id,
            duration_minutes=5.0,
            timestamp=datetime(2026, 1, 2, tzinfo=UTC),
        )
    )
    await s.commit()


async def _seed_course_content_with_completion(
    s: AsyncSession, user_id: int, stage_number: int
) -> None:
    """Seed one content item and mark it completed for the given stage."""
    result = await s.execute(
        select(CourseStage).where(col(CourseStage.stage_number) == stage_number)
    )
    cs = result.scalars().first()
    if cs is None:
        cs = await _seed_course_stage(s, stage_number)
    content = StageContent(
        course_stage_id=cs.id,
        title="c1",
        content_type="essay",
        release_day=0,
        url="u",
    )
    s.add(content)
    await s.commit()
    await s.refresh(content)
    s.add(ContentCompletion(user_id=user_id, content_id=content.id))
    await s.commit()


# ── A. Domain tests ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_wheel_empty_user_all_fullness_zero(session: AsyncSession) -> None:
    """New user with no engagement → every Aspect fullness is 0.0."""
    await _seed_all_course_stages(session)

    result = await compute_wheel_balance(session, user_id=_USER_A)

    assert len(result) == _TOTAL_STAGES
    for item in result:
        assert item["fullness"] == 0.0, f"stage {item['stage_number']} expected 0.0"


@pytest.mark.asyncio
async def test_wheel_single_aspect_engagement_isolates(session: AsyncSession) -> None:
    """Engagement in exactly one stage → that Aspect > 0.0, the other nine = 0.0."""
    await _seed_all_course_stages(session)
    engaged_stage = 3
    await _seed_habit_with_completion(session, _USER_A, engaged_stage)

    result = await compute_wheel_balance(session, user_id=_USER_A)

    assert len(result) == _TOTAL_STAGES
    engaged_item = next(r for r in result if r["stage_number"] == engaged_stage)
    assert engaged_item["fullness"] > 0.0
    for item in result:
        if item["stage_number"] != engaged_stage:
            assert item["fullness"] == 0.0, (
                f"stage {item['stage_number']} expected 0.0, got {item['fullness']}"
            )


@pytest.mark.asyncio
async def test_wheel_partial_engagement_reflects_batch_overall_progress(
    session: AsyncSession,
) -> None:
    """Stages 2 and 5 engaged → their fullness matches batch overall_progress."""
    await _seed_all_course_stages(session)
    await _seed_habit_with_completion(session, _USER_A, 2)
    await _seed_practice_with_session(session, _USER_A, 5)

    result = await compute_wheel_balance(session, user_id=_USER_A)

    stage2 = next(r for r in result if r["stage_number"] == 2)
    stage5 = next(r for r in result if r["stage_number"] == 5)
    assert stage2["fullness"] > 0.0
    assert stage5["fullness"] > 0.0
    # All other stages must remain at zero
    for item in result:
        if item["stage_number"] not in {2, 5}:
            assert item["fullness"] == 0.0


@pytest.mark.asyncio
async def test_wheel_is_deterministic(session: AsyncSession) -> None:
    """Same inputs produce identical output on repeated calls."""
    await _seed_all_course_stages(session)
    await _seed_habit_with_completion(session, _USER_A, 1)
    await _seed_practice_with_session(session, _USER_A, 7)

    first = await compute_wheel_balance(session, user_id=_USER_A)
    second = await compute_wheel_balance(session, user_id=_USER_A)

    assert first == second


@pytest.mark.asyncio
async def test_wheel_order_is_canonical_not_by_fullness(session: AsyncSession) -> None:
    """Items are ordered by stage_number 1..10 even when a later stage has higher fullness."""
    await _seed_all_course_stages(session)
    # Engage stage 8 (higher number) but not stage 1
    await _seed_habit_with_completion(session, _USER_A, 8)

    result = await compute_wheel_balance(session, user_id=_USER_A)

    stage_numbers = [r["stage_number"] for r in result]
    assert stage_numbers == list(range(1, _TOTAL_STAGES + 1)), (
        f"expected canonical order 1..10, got {stage_numbers}"
    )
    # Stage 8 must have higher fullness than stage 1
    s8 = next(r for r in result if r["stage_number"] == 8)
    s1 = next(r for r in result if r["stage_number"] == 1)
    assert s8["fullness"] > s1["fullness"]


@pytest.mark.asyncio
async def test_wheel_returns_exactly_ten_aspects(session: AsyncSession) -> None:
    """The wheel always has exactly ten items, one per stage 1..10."""
    await _seed_all_course_stages(session)

    result = await compute_wheel_balance(session, user_id=_USER_A)

    assert len(result) == _TOTAL_STAGES
    stage_numbers = {r["stage_number"] for r in result}
    assert stage_numbers == set(range(1, _TOTAL_STAGES + 1))


@pytest.mark.asyncio
async def test_wheel_items_carry_aspect_label(session: AsyncSession) -> None:
    """Each result item exposes the aspect string from the CourseStage row."""
    await _seed_all_course_stages(session)

    result = await compute_wheel_balance(session, user_id=_USER_A)

    for item in result:
        expected_aspect = _CANONICAL_ASPECTS[item["stage_number"] - 1]
        assert item["aspect"] == expected_aspect, (
            f"stage {item['stage_number']}: expected aspect {expected_aspect!r}"
        )


@pytest.mark.asyncio
async def test_wheel_fullness_sourced_from_batch_overall_progress(
    session: AsyncSession,
) -> None:
    """Fullness must equal the batch overall_progress (habits only = habit fraction)."""
    await _seed_all_course_stages(session)
    # Two habits for stage 4, one completed → habits_progress = 0.5
    for i in range(2):
        habit = Habit(
            name=f"H4-{i}",
            icon="x",
            start_date=date(2026, 1, 1),
            energy_cost=1,
            energy_return=1,
            user_id=_USER_A,
            stage="4",
            streak=0,
        )
        session.add(habit)
        await session.commit()
        await session.refresh(habit)
        goal = Goal(
            habit_id=habit.id,
            title="g",
            tier="t",
            target=1,
            target_unit="rep",
            frequency=1,
            frequency_unit="per_day",
        )
        session.add(goal)
        await session.commit()
        await session.refresh(goal)
        if i == 0:
            session.add(GoalCompletion(goal_id=goal.id, user_id=_USER_A, completed_units=1))
            await session.commit()

    batch = await compute_stage_progress_batch(session, _USER_A, list(range(1, 11)))
    expected_stage4 = batch[4]["overall_progress"]

    result = await compute_wheel_balance(session, user_id=_USER_A)
    stage4_item = next(r for r in result if r["stage_number"] == 4)

    assert stage4_item["fullness"] == expected_stage4
