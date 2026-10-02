"""``CourseStage.stage_key`` defaults from ``stage_number`` at INSERT (#2665).

The seeder always sets the key; this default exists so the many hand-built
``CourseStage(...)`` rows across the suite (and any future one) satisfy the
NOT NULL, unique column with the key the migration would have backfilled. It is
a context-sensitive default, so these tests prove it per row, including in one
multi-row flush (the insertmanyvalues path).
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.course_stage import CourseStage

_IN_RANGE_STAGE = 4
_OUT_OF_RANGE_STAGE = 12


def _stage(stage_number: int, stage_key: str) -> CourseStage:
    """A minimal hand-built row with an explicit key."""
    return CourseStage(
        stage_key=stage_key,
        stage_number=stage_number,
        title=f"Stage {stage_number}",
        subtitle="s",
        overview_url="",
        category="c",
        aspect="a",
        spiral_dynamics_color="x",
        growing_up_stage="g",
        divine_gender_polarity="d",
        relationship_to_free_will="r",
        free_will_description="f",
    )


def _keyless(stage_number: int) -> CourseStage:
    """A row built without passing ``stage_key`` at all."""
    return CourseStage(
        stage_number=stage_number,
        title=f"Stage {stage_number}",
        subtitle="s",
        overview_url="",
        category="c",
        aspect="a",
        spiral_dynamics_color="x",
        growing_up_stage="g",
        divine_gender_polarity="d",
        relationship_to_free_will="r",
        free_will_description="f",
    )


@pytest.mark.asyncio
async def test_a_keyless_row_gets_its_colour_slug_on_flush(db_session: AsyncSession) -> None:
    """Stage 4 built without a key is stored as ``blue``."""
    row = _keyless(_IN_RANGE_STAGE)
    assert row.stage_key is None

    db_session.add(row)
    await db_session.flush()

    assert row.stage_key == "blue"


@pytest.mark.asyncio
async def test_an_out_of_range_keyless_row_gets_a_placeholder(db_session: AsyncSession) -> None:
    """A row outside the ten Stages gets ``stage-<n>`` rather than failing."""
    row = _keyless(_OUT_OF_RANGE_STAGE)
    db_session.add(row)
    await db_session.flush()

    assert row.stage_key == f"stage-{_OUT_OF_RANGE_STAGE}"


@pytest.mark.asyncio
async def test_each_row_of_a_multi_row_flush_derives_its_own_key(
    db_session: AsyncSession,
) -> None:
    """One batched INSERT still evaluates the default per row."""
    db_session.add_all([_keyless(1), _keyless(_IN_RANGE_STAGE), _keyless(10)])
    await db_session.commit()

    rows = (
        await db_session.execute(
            select(CourseStage.stage_number, CourseStage.stage_key).order_by(
                col(CourseStage.stage_number)
            )
        )
    ).all()
    assert [tuple(r) for r in rows] == [(1, "beige"), (4, "blue"), (10, "clearlight")]


@pytest.mark.asyncio
async def test_an_explicit_key_is_kept(db_session: AsyncSession) -> None:
    """The default never overrides a key the caller set."""
    row = _stage(_IN_RANGE_STAGE, stage_key="custom-key")
    db_session.add(row)
    await db_session.flush()

    assert row.stage_key == "custom-key"
