"""Domain tests for compute_wheel_balance's chord-tag weighting."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from datetime import UTC, date, datetime

import pytest
import pytest_asyncio
from sqlalchemy import JSON
from sqlalchemy.dialects.postgresql import ARRAY as PG_ARRAY
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel

from domain.stage_progress import compute_stage_progress_batch
from domain.wheel import (
    WHEEL_CHORD_SATURATION_TAGS,
    WHEEL_CHORD_SIGNAL_CAP,
    WHEEL_PRIMARY_TAG_WEIGHT,
    WHEEL_SECONDARY_TAG_WEIGHT,
    compute_wheel_balance,
)
from models.course_stage import CourseStage
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.journal_entry import JournalEntry
from models.practice import Practice
from models.practice_session import PracticeSession
from models.user_practice import UserPractice

_CANONICAL_ASPECTS = [
    "Body",
    "Body",
    "Emotion",
    "Emotion",
    "Mind",
    "Mind",
    "Spirit",
    "Spirit",
    "Nondual",
    "Nondual",
]

_TOTAL_STAGES = 10
_USER_A = 1
_SATURATING_TAG_COUNT = 15

# The exact lift a single primary/secondary tag contributes, derived from the
# named constants so this test binds to the real weighting, not a hardcoded number.
_PER_PRIMARY_LIFT = WHEEL_CHORD_SIGNAL_CAP * (
    WHEEL_PRIMARY_TAG_WEIGHT / WHEEL_CHORD_SATURATION_TAGS
)
_PER_SECONDARY_LIFT = WHEEL_CHORD_SIGNAL_CAP * (
    WHEEL_SECONDARY_TAG_WEIGHT / WHEEL_CHORD_SATURATION_TAGS
)


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
    """Insert a CourseStage row so queries resolve."""
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


def _tagged_entry(
    user_id: int,
    *,
    primary: int | None = None,
    secondary: int | None = None,
    deleted: bool = False,
) -> JournalEntry:
    """Build a chord-tagged JournalEntry, optionally soft-deleted."""
    return JournalEntry(
        sender="user",
        user_id=user_id,
        message="A tagged reflection.",
        primary_aspect=primary,
        secondary_aspect=secondary,
        deleted_at=datetime.now(UTC) if deleted else None,
    )


@pytest.mark.asyncio
async def test_wheel_chord_single_primary_tag_lifts_only_its_stage(session: AsyncSession) -> None:
    """A lone primary tag on stage 3 lifts only stage 3's fullness."""
    await _seed_all_course_stages(session)
    session.add(_tagged_entry(_USER_A, primary=3))
    await session.commit()

    result = await compute_wheel_balance(session, user_id=_USER_A)

    for item in result:
        if item["stage_number"] == 3:
            assert item["fullness"] == pytest.approx(_PER_PRIMARY_LIFT)
        else:
            assert item["fullness"] == 0.0, f"stage {item['stage_number']} expected 0.0"


@pytest.mark.asyncio
async def test_wheel_chord_secondary_lifts_half_and_primary_lifts_full(
    session: AsyncSession,
) -> None:
    """secondary=5 with primary=2: stage 5 gets half the lift, stage 2 gets the full lift."""
    await _seed_all_course_stages(session)
    session.add(_tagged_entry(_USER_A, primary=2, secondary=5))
    await session.commit()

    result = await compute_wheel_balance(session, user_id=_USER_A)

    for item in result:
        if item["stage_number"] == 2:
            assert item["fullness"] == pytest.approx(_PER_PRIMARY_LIFT)
        elif item["stage_number"] == 5:
            assert item["fullness"] == pytest.approx(_PER_SECONDARY_LIFT)
        else:
            assert item["fullness"] == 0.0, f"stage {item['stage_number']} expected 0.0"


@pytest.mark.asyncio
async def test_wheel_chord_soft_deleted_entry_contributes_nothing(session: AsyncSession) -> None:
    """A soft-deleted tagged entry must not lift any stage's fullness."""
    await _seed_all_course_stages(session)
    session.add(_tagged_entry(_USER_A, primary=6, secondary=9, deleted=True))
    await session.commit()

    result = await compute_wheel_balance(session, user_id=_USER_A)

    for item in result:
        assert item["fullness"] == 0.0, f"stage {item['stage_number']} expected 0.0"


@pytest.mark.asyncio
async def test_wheel_chord_saturation_caps_signal_at_ceiling(session: AsyncSession) -> None:
    """Enough primary tags on one stage saturate chord_signal at its cap, never above it."""
    await _seed_all_course_stages(session)
    for _ in range(_SATURATING_TAG_COUNT):
        session.add(_tagged_entry(_USER_A, primary=4))
    await session.commit()

    result = await compute_wheel_balance(session, user_id=_USER_A)

    stage4 = next(r for r in result if r["stage_number"] == 4)
    assert stage4["fullness"] == pytest.approx(WHEEL_CHORD_SIGNAL_CAP)
    assert stage4["fullness"] <= 1.0


@pytest.mark.asyncio
async def test_wheel_chord_fullness_clamps_at_one_with_full_engagement(
    session: AsyncSession,
) -> None:
    """A stage already at full overall_progress stays clamped at 1.0 once chord tags are added."""
    await _seed_all_course_stages(session)
    await _seed_habit_with_completion(session, _USER_A, 7)
    for _ in range(_SATURATING_TAG_COUNT):
        session.add(_tagged_entry(_USER_A, primary=7))
    await session.commit()

    batch = await compute_stage_progress_batch(session, _USER_A, [7])
    assert batch[7]["overall_progress"] == pytest.approx(1.0)

    result = await compute_wheel_balance(session, user_id=_USER_A)
    stage7 = next(r for r in result if r["stage_number"] == 7)
    assert stage7["fullness"] == pytest.approx(1.0)


@pytest.mark.asyncio
async def test_wheel_chord_no_tags_matches_batch_overall_progress_exactly(
    session: AsyncSession,
) -> None:
    """With no chord-tagged entries, every stage's fullness equals its overall_progress."""
    await _seed_all_course_stages(session)
    await _seed_habit_with_completion(session, _USER_A, 1)
    await _seed_practice_with_session(session, _USER_A, 8)

    stage_numbers = list(range(1, _TOTAL_STAGES + 1))
    batch = await compute_stage_progress_batch(session, _USER_A, stage_numbers)

    result = await compute_wheel_balance(session, user_id=_USER_A)

    for item in result:
        expected = float(batch[item["stage_number"]]["overall_progress"])
        assert item["fullness"] == pytest.approx(expected)
