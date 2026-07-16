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


# Golden values pinned to the canonical APTITUDE stage ontology so an edit to
# the vendored curriculum dataset cannot silently change the seeded attributes.
_GOLDEN_STAGE_DEFINITIONS: list[dict[str, str | int]] = [
    {
        "stage_number": 1,
        "title": "Survival",
        "subtitle": "Active Yes-And-Ness",
        "overview_url": "",
        "category": "Yes-And-Ness",
        "aspect": "Agency",
        "spiral_dynamics_color": "Beige",
        "growing_up_stage": "Survival",
        "divine_gender_polarity": "Divine Masculine",
        "relationship_to_free_will": "Biological Machine",
        "free_will_description": (
            "Individuals are unaware of the concept of free will. Their actions are purely "
            "reactive and instinctual, driven by basic survival needs. This is the bottom of "
            "Maslow's Pyramid, the Root Chakra, the first stage Piaget's cognitive development or "
            "step one of Erikson's psychosocial development etc."
        ),
    },
    {
        "stage_number": 2,
        "title": "Magick",
        "subtitle": "Receptive Yes-And-Ness",
        "overview_url": "",
        "category": "Yes-And-Ness",
        "aspect": "Receptivity",
        "spiral_dynamics_color": "Purple",
        "growing_up_stage": "Magic",
        "divine_gender_polarity": "Divine Feminine",
        "relationship_to_free_will": "Archetype Embodier",
        "free_will_description": (
            "Individual personalities (collections of habits—which are frequently repeated "
            "behaviors) are the combined effort of archetypal role models, including everything "
            "from fictional characters to societal celebrities (and perhaps ancient gods in "
            "polytheistic cultures)"
        ),
    },
    {
        "stage_number": 3,
        "title": "Power",
        "subtitle": "Self-Love",
        "overview_url": "",
        "category": "Love",
        "aspect": "Self-Love",
        "spiral_dynamics_color": "Red",
        "growing_up_stage": "Ego-centrism",
        "divine_gender_polarity": "Divine Masculine",
        "relationship_to_free_will": "Dominator",
        "free_will_description": (
            "Behavior is driven by a subconscious urge to alleviate the pain of emotions (that "
            "may or may not even be consciously noticed) that tell us that we are not enough. "
            "Without self-love toward these aversion based feelings, the tendency is to forge "
            'dominator "power over others."'
        ),
    },
    {
        "stage_number": 4,
        "title": "Conformity",
        "subtitle": "Universal Love",
        "overview_url": "",
        "category": "Love",
        "aspect": "Community Love",
        "spiral_dynamics_color": "Blue",
        "growing_up_stage": "Conformity",
        "divine_gender_polarity": "Divine Feminine",
        "relationship_to_free_will": "Victim",
        "free_will_description": (
            "Behavior is determined by the attempt to meet the expectations of the relationships "
            "that the individual is embedded within; we are defined by roles: partners, parents, "
            "children, coworkers, friends, pupils, etc"
        ),
    },
    {
        "stage_number": 5,
        "title": "Achievist",
        "subtitle": "Intellectual Understanding",
        "overview_url": "",
        "category": "Understanding",
        "aspect": "Intellectual Understanding",
        "spiral_dynamics_color": "Orange",
        "growing_up_stage": "Achievest",
        "divine_gender_polarity": "Divine Masculine",
        "relationship_to_free_will": "Status Seeker",
        "free_will_description": (
            "Behavior is based on chasing things valued by the culture: money, wealth, status, "
            "privilege, fame… in short, achievement. Although the question may arise, Free Will "
            "is still uninteresting and left largely unconsidered"
        ),
    },
    {
        "stage_number": 6,
        "title": "Pluralist",
        "subtitle": "Embodied Understanding",
        "overview_url": "",
        "category": "Understanding",
        "aspect": "Embodied Understanding",
        "spiral_dynamics_color": "Green",
        "growing_up_stage": "Pluralistic",
        "divine_gender_polarity": "Divine Feminine",
        "relationship_to_free_will": "Shadow Glorifier",
        "free_will_description": (
            "Behavior is driven by a desire to be virtuous, to apply rules fairly, to reduce the "
            "influence of hierarchy, and to respect everyone's perspectives. Free Will is still "
            "absent as behavior follows predictably from a set of pluralistic heuristics."
        ),
    },
    {
        "stage_number": 7,
        "title": "Integrative",
        "subtitle": "Systems Wisdom",
        "overview_url": "",
        "category": "Wisdom",
        "aspect": "Systems Wisdom",
        "spiral_dynamics_color": "Yellow",
        "growing_up_stage": "Integrative",
        "divine_gender_polarity": "Divine Masculine",
        "relationship_to_free_will": "Despairing Analyst",
        "free_will_description": (
            "The ability to reflect on all the influences of stages prior to Yellow develops and "
            "the individual becomes convinced that Free Will is essentially an illusion."
        ),
    },
    {
        "stage_number": 8,
        "title": "Nondual",
        "subtitle": "Transcendent Wisdom",
        "overview_url": "",
        "category": "Wisdom",
        "aspect": "True Self Connection",
        "spiral_dynamics_color": "Teal",
        "growing_up_stage": "Nonduality",
        "divine_gender_polarity": "Divine Feminine",
        "relationship_to_free_will": "True Self Embodier",
        "free_will_description": (
            "Spiritual development that leads to an experience of the nondual nature of the "
            "Kosmos that allows the Adept to burn off karma, develop nonreactivity, break "
            "unhealthy and ineffective patterns, escape samsara and unbridle from determinism "
            "effectively."
        ),
    },
    {
        "stage_number": 9,
        "title": "Effortless Being",
        "subtitle": "Unity of Being",
        "overview_url": "",
        "category": "Being",
        "aspect": "Unity",
        "spiral_dynamics_color": "Ultraviolet",
        "growing_up_stage": "Effortless Being",
        "divine_gender_polarity": "Divine Hermaphrodite",
        "relationship_to_free_will": "Blissy Adept",
        "free_will_description": (
            'The obsession with "Free" Will of the previous two stages grows less all consuming '
            "and the goal becomes to subsume individual Will into alignment with the Will of "
            "Source. Blissful Union of Atman and Brahman."
        ),
    },
    {
        "stage_number": 10,
        "title": "Pure Awareness",
        "subtitle": "Emptiness and Awareness",
        "overview_url": "",
        "category": "Awareness",
        "aspect": "Emptiness",
        "spiral_dynamics_color": "Clear Light",
        "growing_up_stage": "Pure Awareness",
        "divine_gender_polarity": "Divine Hermaphrodite",
        "relationship_to_free_will": "Whole Adept",
        "free_will_description": (
            "There is no longer an individual who can have Free Will. This body becomes a perfect "
            "instrument of the evolution of consciousness, an empty Nobody who simply does the "
            "perfect thing in every situation—the thing that will result in the most spiritual "
            "growth for all involved."
        ),
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
    """STAGE_DEFINITIONS must equal the canonical golden literal, field for field.

    Guards against the vendored curriculum dataset drifting away from the
    canonical APTITUDE stage ontology that STAGE_DEFINITIONS is derived from.
    """
    assert len(STAGE_DEFINITIONS) == len(_GOLDEN_STAGE_DEFINITIONS)

    actual_by_number = {d["stage_number"]: d for d in STAGE_DEFINITIONS}
    for golden in _GOLDEN_STAGE_DEFINITIONS:
        actual = actual_by_number[golden["stage_number"]]
        for field in _GOLDEN_FIELDS:
            msg = f"stage {golden['stage_number']} field {field!r} mismatch"
            assert actual[field] == golden[field], msg


async def _fetch_stage(session: AsyncSession, stage_number: int) -> CourseStage:
    """Return the single persisted CourseStage row for a stage number."""
    result = await session.execute(
        select(CourseStage).where(CourseStage.stage_number == stage_number),
    )
    stage = result.scalars().one()
    assert stage is not None
    return stage


@pytest.mark.asyncio
async def test_seed_stages_reconciles_stale_row(db_session: AsyncSession) -> None:
    """A pre-existing row carrying stale attributes is corrected in place on re-seed."""
    await seed_stages(db_session)
    stale = await _fetch_stage(db_session, 1)
    original_id = stale.id
    stale.aspect = "Body"
    stale.spiral_dynamics_color = "Turquoise"
    stale.category = "Pre-personal"
    await db_session.commit()

    reinserted = await seed_stages(db_session)
    assert reinserted == 0

    refreshed = await _fetch_stage(db_session, 1)
    assert refreshed.id == original_id
    assert refreshed.aspect == "Agency"
    assert refreshed.spiral_dynamics_color == "Beige"
    assert refreshed.category == "Yes-And-Ness"

    result = await db_session.execute(select(CourseStage))
    assert len(result.scalars().all()) == len(STAGE_DEFINITIONS)


@pytest.mark.asyncio
async def test_seed_stages_preserves_overview_url_on_reconcile(
    db_session: AsyncSession,
) -> None:
    """Reconciliation corrects drifted fields while leaving overview_url intact."""
    await seed_stages(db_session)
    row = await _fetch_stage(db_session, 1)
    row.overview_url = "https://example.test/stage-1"
    row.aspect = "Body"
    await db_session.commit()

    await seed_stages(db_session)

    refreshed = await _fetch_stage(db_session, 1)
    assert refreshed.aspect == "Agency"
    assert refreshed.overview_url == "https://example.test/stage-1"
