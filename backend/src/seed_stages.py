"""Seed script for the 10 APTITUDE CourseStage definitions.

The Stage attributes are sourced from the vendored Archetypal Wavelength
curriculum dataset (:mod:`curriculum`), the single source of truth for
per-Stage copy.  The loader enforces that the ten Stages are present, unique,
and complete, so this module maps that validated data into the seed dicts the
ORM expects, adding the seeder-owned ``overview_url``.
"""

from __future__ import annotations

from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

import curriculum
from models.course_stage import CourseStage
from seed_helpers import existing_system_keys

#: The curriculum dataset does not carry per-Stage overview URLs; they are a
#: seeder concern and default to empty until populated elsewhere.
DEFAULT_OVERVIEW_URL: Final[str] = ""


def _to_definition(stage: curriculum.StageCurriculum) -> dict[str, str | int]:
    """Map a curriculum Stage to the ORM seed dict for :class:`CourseStage`."""
    return {
        "stage_number": stage.stage_number,
        "title": stage.title,
        "subtitle": stage.subtitle,
        "overview_url": DEFAULT_OVERVIEW_URL,
        "category": stage.category,
        "aspect": stage.aspect,
        "spiral_dynamics_color": stage.spiral_dynamics_color,
        "growing_up_stage": stage.growing_up_stage,
        "divine_gender_polarity": stage.divine_gender_polarity,
        "relationship_to_free_will": stage.relationship_to_free_will,
        "free_will_description": stage.free_will_description,
    }


STAGE_DEFINITIONS: list[dict[str, str | int]] = [
    _to_definition(stage) for stage in curriculum.all_stages()
]


async def seed_stages(session: AsyncSession) -> int:
    """Insert stage definitions if they don't already exist.

    Returns the number of stages inserted.
    """
    existing = await existing_system_keys(session, CourseStage.stage_number)

    inserted = 0
    for definition in STAGE_DEFINITIONS:
        if definition["stage_number"] not in existing:
            stage = CourseStage(**definition)
            session.add(stage)
            inserted += 1

    if inserted:
        await session.commit()
    return inserted
