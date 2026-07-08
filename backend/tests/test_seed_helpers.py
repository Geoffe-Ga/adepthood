"""Tests for the shared idempotent-seed helpers.

Pins the contract two seeders (seed_practices, seed_practice_recipes) both
need: a natural-key existence lookup and a commit-or-yield-to-race-winner
guard, so future seeders can share one implementation instead of
duplicating both patterns.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.course_stage import CourseStage
from models.practice import Practice
from models.practice_tag import PracticeTag
from seed_helpers import commit_or_yield_to_race_winner, existing_system_keys

#: Arbitrary owner id for a user-owned row planted to prove the owner filter
#: excludes it from the "system" result set.
_USER_OWNER_ID = 42

_PRESET_PRACTICE: dict[str, object] = {
    "stage_number": 1,
    "name": "Preset Practice",
    "description": "system preset",
    "instructions": "do the thing",
    "default_duration_minutes": 5,
    "submitted_by_user_id": None,
    "approved": True,
    "mode": "count_up",
    "mode_config": {"mode": "count_up", "soft_cap_minutes": None},
}

_USER_PRACTICE: dict[str, object] = {
    "stage_number": 1,
    "name": "User Practice",
    "description": "user submission",
    "instructions": "do the other thing",
    "default_duration_minutes": 5,
    "submitted_by_user_id": _USER_OWNER_ID,
    "approved": False,
    "mode": "count_up",
    "mode_config": {"mode": "count_up", "soft_cap_minutes": None},
}


def _stage(stage_number: int) -> CourseStage:
    """Build a fully-populated CourseStage (every column is NOT NULL)."""
    return CourseStage(
        stage_number=stage_number,
        title=f"Stage {stage_number}",
        subtitle="subtitle",
        overview_url="",
        category="category",
        aspect="aspect",
        spiral_dynamics_color="beige",
        growing_up_stage="stage",
        divine_gender_polarity="neutral",
        relationship_to_free_will="none",
        free_will_description="desc",
    )


@pytest.mark.asyncio
async def test_existing_system_keys_single_column_filters_by_owner(
    db_session: AsyncSession,
) -> None:
    """Single-column lookup returns a ``set[str]`` of only the system rows."""
    db_session.add(PracticeTag(slug="system-tag", label="System Tag"))
    db_session.add(PracticeTag(slug="user-tag", label="User Tag", owner_user_id=_USER_OWNER_ID))
    await db_session.commit()

    result = await existing_system_keys(
        db_session, PracticeTag.slug, owner_col=PracticeTag.owner_user_id
    )

    assert result == {"system-tag"}
    assert isinstance(result, set)
    assert all(isinstance(item, str) for item in result)


@pytest.mark.asyncio
async def test_existing_system_keys_two_columns_returns_tuple_set(
    db_session: AsyncSession,
) -> None:
    """Two-column lookup returns a ``set`` of composite-key tuples."""
    db_session.add(Practice(**_PRESET_PRACTICE))
    db_session.add(Practice(**_USER_PRACTICE))
    await db_session.commit()

    result = await existing_system_keys(
        db_session,
        Practice.stage_number,
        Practice.name,
        owner_col=Practice.submitted_by_user_id,
    )

    assert result == {(1, "Preset Practice")}
    key = next(iter(result))
    assert isinstance(key, tuple)


@pytest.mark.asyncio
async def test_existing_system_keys_without_owner_col_returns_all_rows(
    db_session: AsyncSession,
) -> None:
    """Omitting ``owner_col`` applies no ownership filter at all."""
    db_session.add(_stage(1))
    db_session.add(_stage(2))
    db_session.add(_stage(3))
    await db_session.commit()

    result = await existing_system_keys(db_session, CourseStage.stage_number)

    assert result == {1, 2, 3}


@pytest.mark.asyncio
async def test_existing_system_keys_empty_table_returns_empty_set(
    db_session: AsyncSession,
) -> None:
    """An empty table returns an empty set, not ``None`` or a KeyError."""
    result = await existing_system_keys(
        db_session, PracticeTag.slug, owner_col=PracticeTag.owner_user_id
    )

    assert result == set()


@pytest.mark.asyncio
async def test_commit_or_yield_to_race_winner_happy_path_persists_row(
    db_session: AsyncSession,
) -> None:
    """A clean commit returns ``inserted`` and the staged row is persisted."""
    db_session.add(_stage(1))

    result = await commit_or_yield_to_race_winner(db_session, 1)

    assert result == 1
    rows = (await db_session.execute(select(CourseStage))).scalars().all()
    assert len(rows) == 1
    assert rows[0].stage_number == 1


@pytest.mark.asyncio
async def test_commit_or_yield_to_race_winner_race_loser_returns_zero(
    db_session: AsyncSession,
) -> None:
    """A duplicate-key commit rolls back, returns 0, and leaves the session usable."""
    db_session.add(Practice(**_PRESET_PRACTICE))
    await db_session.commit()

    db_session.add(Practice(**_PRESET_PRACTICE))
    result = await commit_or_yield_to_race_winner(db_session, 1)

    assert result == 0
    rows = (
        (await db_session.execute(select(Practice).where(Practice.name == "Preset Practice")))
        .scalars()
        .all()
    )
    assert len(rows) == 1

    # The session must still be usable after the rollback.
    stages = (await db_session.execute(select(CourseStage))).scalars().all()
    assert stages == []
