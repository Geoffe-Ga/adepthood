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


# Golden values pinned from the pre-refactor STAGE_DEFINITIONS literal so a
# migration to a curriculum-backed source cannot silently change behavior.
_GOLDEN_STAGE_DEFINITIONS: list[dict[str, str | int]] = [
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

_GOLDEN_FIELDS = (
    "stage_number",
    "title",
    "subtitle",
    "aspect",
    "spiral_dynamics_color",
    "category",
    "growing_up_stage",
    "divine_gender_polarity",
    "relationship_to_free_will",
    "free_will_description",
    "overview_url",
)


def test_stage_definitions_match_golden_values() -> None:
    """STAGE_DEFINITIONS must equal the pre-refactor literal, field for field.

    Guards against behavior change if STAGE_DEFINITIONS is later derived from
    the vendored curriculum dataset instead of the hardcoded literal.
    """
    assert len(STAGE_DEFINITIONS) == len(_GOLDEN_STAGE_DEFINITIONS)

    actual_by_number = {d["stage_number"]: d for d in STAGE_DEFINITIONS}
    for golden in _GOLDEN_STAGE_DEFINITIONS:
        actual = actual_by_number[golden["stage_number"]]
        for field in _GOLDEN_FIELDS:
            msg = f"stage {golden['stage_number']} field {field!r} mismatch"
            assert actual[field] == golden[field], msg


def test_stage_definitions_overview_url_is_empty_for_all() -> None:
    """overview_url golden value is the empty string for every stage."""
    for defn in STAGE_DEFINITIONS:
        assert defn["overview_url"] == ""
