"""Tests for the seed_content script."""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from content_config import STAGE_PLANS, all_chapter_records
from models.course_stage import CourseStage
from models.stage_content import StageContent
from seed_content import desired_content_records, seed_content

# Chapters seeded for the live stages (today: just beige = 14).
_PLANNED_CHAPTER_COUNT = sum(plan.chapter_count for plan in STAGE_PLANS)
# Placeholders kept for stages 2 and 3 (3 each).
_PLACEHOLDER_COUNT = 6


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
    """Seeding with stages present inserts configured chapters + placeholders."""
    await _seed_stages(db_session, count=3)
    inserted = await seed_content(db_session)
    expected_total = _PLANNED_CHAPTER_COUNT + _PLACEHOLDER_COUNT
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


@pytest.mark.asyncio
async def test_seed_content_creates_beige_chapters(db_session: AsyncSession) -> None:
    """Stage 1 (Beige) gets the configured chapter set, not placeholders."""
    await _seed_stages(db_session, count=1)
    await seed_content(db_session)

    result = await db_session.execute(
        select(StageContent)
        .join(CourseStage)
        .where(CourseStage.stage_number == 1)
        .order_by(col(StageContent.release_day))
    )
    items = list(result.scalars().all())

    # The beige plan ships 14 chapters.
    beige_plan = next(p for p in STAGE_PLANS if p.stage_number == 1)
    assert len(items) == beige_plan.chapter_count
    assert items[0].url == "https://aptitude.guru/course/beige-1"
    assert items[-1].url == f"https://aptitude.guru/course/beige-{beige_plan.chapter_count}"
    # Chapter type is uniform across the plan.
    assert {item.content_type for item in items} == {"chapter"}


@pytest.mark.asyncio
async def test_seed_content_reconciles_url_drift(db_session: AsyncSession) -> None:
    """A row whose URL drifted from the config is updated in place, not duplicated."""
    await _seed_stages(db_session, count=1)
    await seed_content(db_session)

    # Manually corrupt one URL — simulates a chapter being moved on the CMS.
    result = await db_session.execute(select(StageContent).where(StageContent.title == "Chapter 1"))
    row = result.scalars().one()
    original_url = row.url
    row.url = "https://aptitude.guru/course/beige-1-OLD"
    await db_session.commit()

    # Re-seeding should reset the URL to the config value without inserting
    # a duplicate row.
    inserted = await seed_content(db_session)
    assert inserted == 0
    await db_session.refresh(row)
    assert row.url == original_url


def test_desired_content_records_counts() -> None:
    """Flat list of desired records covers every chapter plus surviving placeholders."""
    records = desired_content_records()
    planned = all_chapter_records()
    assert len(records) == len(planned) + _PLACEHOLDER_COUNT
    # All configured chapters should be present.
    planned_urls = {r.url for r in planned}
    record_urls = {r.url for r in records}
    assert planned_urls.issubset(record_urls)
