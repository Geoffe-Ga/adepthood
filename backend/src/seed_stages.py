"""Seed script for the 10 APTITUDE CourseStage definitions."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.course_stage import CourseStage

_STAGE_DEFINITIONS: list[dict[str, str | int]] = [
    {
        "stage_number": 1,
        "title": "Survival",
        "subtitle": "Active Yes-And-Ness",
        "overview_url": "",
        "category": "Pre-personal",
        "aspect": "Body",
        "spiral_dynamics_color": "Beige",
        "growing_up_stage": "Archaic",
        "divine_gender_polarity": "Masculine",
        "relationship_to_free_will": "Reactive",
        "free_will_description": "Instinctual response to environment",
    },
    {
        "stage_number": 2,
        "title": "Magick",
        "subtitle": "Receptive Yes-And-Ness",
        "overview_url": "",
        "category": "Pre-personal",
        "aspect": "Body",
        "spiral_dynamics_color": "Purple",
        "growing_up_stage": "Magic",
        "divine_gender_polarity": "Feminine",
        "relationship_to_free_will": "Receptive",
        "free_will_description": "Surrender to tribal belonging",
    },
    {
        "stage_number": 3,
        "title": "Power",
        "subtitle": "Self-Love",
        "overview_url": "",
        "category": "Pre-personal",
        "aspect": "Emotion",
        "spiral_dynamics_color": "Red",
        "growing_up_stage": "Power Gods",
        "divine_gender_polarity": "Masculine",
        "relationship_to_free_will": "Assertive",
        "free_will_description": "Willful self-assertion",
    },
    {
        "stage_number": 4,
        "title": "Conformity",
        "subtitle": "Universal Love",
        "overview_url": "",
        "category": "Personal",
        "aspect": "Emotion",
        "spiral_dynamics_color": "Blue",
        "growing_up_stage": "Mythic Order",
        "divine_gender_polarity": "Feminine",
        "relationship_to_free_will": "Obedient",
        "free_will_description": "Submission to higher order",
    },
    {
        "stage_number": 5,
        "title": "Achievist",
        "subtitle": "Intellectual Understanding",
        "overview_url": "",
        "category": "Personal",
        "aspect": "Mind",
        "spiral_dynamics_color": "Orange",
        "growing_up_stage": "Scientific-Rational",
        "divine_gender_polarity": "Masculine",
        "relationship_to_free_will": "Strategic",
        "free_will_description": "Calculated self-determination",
    },
    {
        "stage_number": 6,
        "title": "Pluralist",
        "subtitle": "Embodied Understanding",
        "overview_url": "",
        "category": "Personal",
        "aspect": "Mind",
        "spiral_dynamics_color": "Green",
        "growing_up_stage": "Sensitive Self",
        "divine_gender_polarity": "Feminine",
        "relationship_to_free_will": "Collaborative",
        "free_will_description": "Co-creation through empathy",
    },
    {
        "stage_number": 7,
        "title": "Integrative",
        "subtitle": "Systems Wisdom",
        "overview_url": "",
        "category": "Trans-personal",
        "aspect": "Spirit",
        "spiral_dynamics_color": "Yellow",
        "growing_up_stage": "Integral",
        "divine_gender_polarity": "Masculine",
        "relationship_to_free_will": "Systemic",
        "free_will_description": "Functional flow within systems",
    },
    {
        "stage_number": 8,
        "title": "Nondual",
        "subtitle": "Transcendent Wisdom",
        "overview_url": "",
        "category": "Trans-personal",
        "aspect": "Spirit",
        "spiral_dynamics_color": "Turquoise",
        "growing_up_stage": "Holistic",
        "divine_gender_polarity": "Feminine",
        "relationship_to_free_will": "Surrendered",
        "free_will_description": "Alignment with universal flow",
    },
    {
        "stage_number": 9,
        "title": "Effortless Being",
        "subtitle": "Unity of Being",
        "overview_url": "",
        "category": "Trans-personal",
        "aspect": "Nondual",
        "spiral_dynamics_color": "Ultraviolet",
        "growing_up_stage": "Para-mind",
        "divine_gender_polarity": "Integrated",
        "relationship_to_free_will": "Effortless",
        "free_will_description": "Spontaneous right action",
    },
    {
        "stage_number": 10,
        "title": "Pure Awareness",
        "subtitle": "Emptiness and Awareness",
        "overview_url": "",
        "category": "Trans-personal",
        "aspect": "Nondual",
        "spiral_dynamics_color": "Clear Light",
        "growing_up_stage": "Meta-mind",
        "divine_gender_polarity": "Transcendent",
        "relationship_to_free_will": "Witnessing",
        "free_will_description": "Free will and determinism as one",
    },
]

# BUG-SEED-002: Assert uniqueness of stage_numbers at import time so a
# duplicate definition is caught immediately, not silently ignored at runtime.
_stage_numbers = [d["stage_number"] for d in _STAGE_DEFINITIONS]
if len(set(_stage_numbers)) != len(_stage_numbers):
    _dupes = sorted(n for n in _stage_numbers if _stage_numbers.count(n) > 1)
    msg = f"Duplicate stage_number in STAGE_DEFINITIONS: {_dupes}"
    raise ValueError(msg)

STAGE_DEFINITIONS = _STAGE_DEFINITIONS


async def seed_stages(session: AsyncSession) -> int:
    """Insert stage definitions if they don't already exist.

    Returns the number of stages inserted.
    """
    result = await session.execute(select(CourseStage))
    existing = {s.stage_number for s in result.scalars().all()}

    inserted = 0
    for definition in STAGE_DEFINITIONS:
        if definition["stage_number"] not in existing:
            stage = CourseStage(**definition)
            session.add(stage)
            inserted += 1

    if inserted:
        await session.commit()
    return inserted
