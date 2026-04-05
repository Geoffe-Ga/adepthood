"""Tests for the stage seed script."""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.course_stage import CourseStage
from seed_stages import STAGE_DEFINITIONS, seed_stages


@pytest.mark.asyncio
async def test_seed_stages_inserts_all(db_session: AsyncSession) -> None:
    """Seeding into an empty DB should insert all 10 stages."""
    inserted = await seed_stages(db_session)
    assert inserted == len(STAGE_DEFINITIONS)

    result = await db_session.execute(select(CourseStage))
    stages = result.scalars().all()
    assert len(stages) == len(STAGE_DEFINITIONS)


@pytest.mark.asyncio
async def test_seed_stages_idempotent(db_session: AsyncSession) -> None:
    """Running seed twice should not duplicate stages."""
    first = await seed_stages(db_session)
    second = await seed_stages(db_session)
    assert first == len(STAGE_DEFINITIONS)
    assert second == 0

    result = await db_session.execute(select(CourseStage))
    stages = result.scalars().all()
    assert len(stages) == len(STAGE_DEFINITIONS)


@pytest.mark.asyncio
async def test_seed_stages_definitions_valid() -> None:
    """All definitions should have the required fields."""
    required_fields = {
        "stage_number",
        "title",
        "subtitle",
        "overview_url",
        "category",
        "aspect",
        "spiral_dynamics_color",
        "growing_up_stage",
        "divine_gender_polarity",
        "relationship_to_free_will",
        "free_will_description",
    }
    for defn in STAGE_DEFINITIONS:
        msg = f"Missing fields in stage {defn.get('stage_number')}"
        assert required_fields.issubset(defn.keys()), msg
