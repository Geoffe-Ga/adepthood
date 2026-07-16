"""Seed script for the 10 APTITUDE CourseStage definitions.

The Stage attributes are sourced from the vendored Archetypal Wavelength
curriculum dataset (:mod:`curriculum`), the single source of truth for
per-Stage copy.  The loader enforces that the ten Stages are present, unique,
and complete, so this module maps that validated data into the seed dicts the
ORM expects, adding the seeder-owned ``overview_url``.

Seeding is insert-plus-reconcile and non-destructive, mirroring
:mod:`seed_content`: missing Stages are inserted, and Stages already present
have their curriculum-sourced fields refreshed in place when they have drifted
from the dataset.  Rows are never deleted, and the seeder-owned
``overview_url`` is left untouched during reconciliation.
"""

from __future__ import annotations

from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

import curriculum
from models.course_stage import CourseStage
from seed_helpers import commit_or_yield_to_race_winner

#: The curriculum dataset does not carry per-Stage overview URLs; they are a
#: seeder concern and default to empty until populated elsewhere.
DEFAULT_OVERVIEW_URL: Final[str] = ""

#: Curriculum-sourced columns reconciled in place on re-seed. ``stage_number``
#: is the natural key (never reassigned) and ``overview_url`` is seeder-owned,
#: so both are deliberately excluded.
_RECONCILED_FIELDS: Final[tuple[str, ...]] = (
    "title",
    "subtitle",
    "category",
    "aspect",
    "spiral_dynamics_color",
    "growing_up_stage",
    "divine_gender_polarity",
    "relationship_to_free_will",
    "free_will_description",
)


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


def _apply_definition(stage: CourseStage, definition: dict[str, str | int]) -> bool:
    """Refresh ``stage``'s curriculum-sourced fields from ``definition``.

    Assigns each reconciled field only when it differs, leaving the
    seeder-owned ``overview_url`` and the ``stage_number`` key untouched.
    Returns ``True`` when any field was changed.
    """
    changed = False
    for field in _RECONCILED_FIELDS:
        if getattr(stage, field) != definition[field]:
            setattr(stage, field, definition[field])
            changed = True
    return changed


def _insert_or_reconcile(
    session: AsyncSession,
    existing: dict[int, CourseStage],
    definition: dict[str, str | int],
) -> tuple[int, bool]:
    """Insert ``definition`` if its Stage is missing, else reconcile in place.

    Returns ``(inserted, changed)`` — the insert count for this definition
    (0 or 1) and whether the session now holds a pending change for it.
    """
    stage = existing.get(int(definition["stage_number"]))
    if stage is None:
        session.add(CourseStage(**definition))
        return 1, True
    return 0, _apply_definition(stage, definition)


async def seed_stages(session: AsyncSession) -> int:
    """Insert missing stage definitions and reconcile existing ones in place.

    Stages absent from the table are inserted; Stages already present have
    their curriculum-sourced fields refreshed when they have drifted from the
    dataset, without disturbing the seeder-owned ``overview_url``.  Returns the
    number of Stages inserted (in-place updates are not counted). The session
    is committed when there were inserts or in-place changes, and skipped
    otherwise so a re-run of identical data is a true no-op.

    The commit is race-safe: two workers booting concurrently (uvicorn
    ``--workers N``) can both pass the existence check on a fresh database, so
    the loser's insert hits the ``ix_coursestage_stage_number_unique`` index
    (migration ``e8f9a0b1c2d3``) and yields as a no-op instead of duplicating
    every Stage.
    """
    result = await session.execute(select(CourseStage))
    existing = {stage.stage_number: stage for stage in result.scalars()}

    inserted = 0
    dirty = False
    for definition in STAGE_DEFINITIONS:
        added, changed = _insert_or_reconcile(session, existing, definition)
        inserted += added
        dirty = dirty or changed

    if dirty:
        return await commit_or_yield_to_race_winner(session, inserted)
    return inserted
