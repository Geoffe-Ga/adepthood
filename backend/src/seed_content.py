"""Seed script for placeholder StageContent entries for stages 1-3."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.course_stage import CourseStage
from models.stage_content import StageContent

CONTENT_DEFINITIONS: list[dict[str, str | int]] = [
    # Stage 1 — Survival
    {
        "stage_number": 1,
        "title": "Introduction to Survival",
        "content_type": "essay",
        "release_day": 0,
        "url": "https://cms.adepthood.com/stage-1/intro",
    },
    {
        "stage_number": 1,
        "title": "Body Awareness Practice",
        "content_type": "video",
        "release_day": 3,
        "url": "https://cms.adepthood.com/stage-1/body-awareness",
    },
    {
        "stage_number": 1,
        "title": "Survival Reflection Prompt",
        "content_type": "prompt",
        "release_day": 7,
        "url": "https://cms.adepthood.com/stage-1/reflection",
    },
    # Stage 2 — Magick
    {
        "stage_number": 2,
        "title": "Introduction to Magick",
        "content_type": "essay",
        "release_day": 0,
        "url": "https://cms.adepthood.com/stage-2/intro",
    },
    {
        "stage_number": 2,
        "title": "Tribal Connection Exercise",
        "content_type": "video",
        "release_day": 3,
        "url": "https://cms.adepthood.com/stage-2/tribal-connection",
    },
    {
        "stage_number": 2,
        "title": "Magick Reflection Prompt",
        "content_type": "prompt",
        "release_day": 7,
        "url": "https://cms.adepthood.com/stage-2/reflection",
    },
    # Stage 3 — Power
    {
        "stage_number": 3,
        "title": "Introduction to Power",
        "content_type": "essay",
        "release_day": 0,
        "url": "https://cms.adepthood.com/stage-3/intro",
    },
    {
        "stage_number": 3,
        "title": "Self-Assertion Practice",
        "content_type": "video",
        "release_day": 3,
        "url": "https://cms.adepthood.com/stage-3/self-assertion",
    },
    {
        "stage_number": 3,
        "title": "Power Reflection Prompt",
        "content_type": "prompt",
        "release_day": 7,
        "url": "https://cms.adepthood.com/stage-3/reflection",
    },
]


def _build_content_item(
    definition: dict[str, str | int],
    stage_map: dict[int, int],
    existing_titles: set[tuple[int, str]],
) -> StageContent | None:
    """Create a StageContent from a definition.

    Returns None if it already exists or the stage is missing.
    """
    stage_num = int(definition["stage_number"])
    course_stage_id = stage_map.get(stage_num)
    if course_stage_id is None:
        return None

    if (course_stage_id, definition["title"]) in existing_titles:
        return None

    return StageContent(
        course_stage_id=course_stage_id,
        title=str(definition["title"]),
        content_type=str(definition["content_type"]),
        release_day=int(definition["release_day"]),
        url=str(definition["url"]),
    )


async def _load_stage_map(session: AsyncSession) -> dict[int, int]:
    """Build a map of stage_number → CourseStage.id from the database."""
    result = await session.execute(select(CourseStage))
    return {s.stage_number: s.id for s in result.scalars().all() if s.id is not None}


async def _load_existing_titles(session: AsyncSession) -> set[tuple[int, str]]:
    """Return set of (course_stage_id, title) pairs already in the database."""
    result = await session.execute(select(StageContent))
    return {(sc.course_stage_id, sc.title) for sc in result.scalars().all()}


async def seed_content(session: AsyncSession) -> int:
    """Insert placeholder content for stages 1-3 if not already present.

    Returns the number of items inserted.
    """
    stage_map = await _load_stage_map(session)
    existing_titles = await _load_existing_titles(session)

    inserted = 0
    for definition in CONTENT_DEFINITIONS:
        content = _build_content_item(definition, stage_map, existing_titles)
        if content is not None:
            session.add(content)
            inserted += 1

    if inserted:
        await session.commit()
    return inserted
