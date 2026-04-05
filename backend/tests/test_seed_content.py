"""Tests for the seed_content script."""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.course_stage import CourseStage
from models.stage_content import StageContent
from seed_content import seed_content


async def _seed_stages(db_session: AsyncSession, count: int = 3) -> None:
    """Insert test stages into the DB."""
    for i in range(1, count + 1):
        stage = CourseStage(
            title=f"Stage {i}",
            subtitle=f"Subtitle {i}",
            stage_number=i,
            overview_url=f"https://example.com/stage-{i}",
            category="test",
            aspect="test-aspect",
            spiral_dynamics_color="beige",
            growing_up_stage="archaic",
            divine_gender_polarity="masculine",
            relationship_to_free_will="active",
            free_will_description="Active Yes-And-Ness",
        )
        db_session.add(stage)
    await db_session.commit()


@pytest.mark.asyncio
async def test_seed_content_inserts_items(db_session: AsyncSession) -> None:
    """Seeding with stages present inserts content items."""
    await _seed_stages(db_session, count=3)
    inserted = await seed_content(db_session)
    expected_per_stage = 3
    expected_total = expected_per_stage * 3
    assert inserted == expected_total

    result = await db_session.execute(select(StageContent))
    items = result.scalars().all()
    assert len(items) == expected_total


@pytest.mark.asyncio
async def test_seed_content_idempotent(db_session: AsyncSession) -> None:
    """Running seed_content twice doesn't duplicate items."""
    await _seed_stages(db_session, count=3)
    first = await seed_content(db_session)
    second = await seed_content(db_session)
    assert first > 0
    assert second == 0


@pytest.mark.asyncio
async def test_seed_content_no_stages(db_session: AsyncSession) -> None:
    """Without stages, no content is inserted."""
    inserted = await seed_content(db_session)
    assert inserted == 0
