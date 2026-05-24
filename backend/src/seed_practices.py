"""Seed script for the default :class:`Practice` catalog rows.

Mirrors :mod:`seed_stages` — defines the preset list, validates each
``mode_config`` payload at import time so a typo crashes the seeder (not
the runtime), and inserts only what is missing on a per-call basis.

Each :class:`~models.course_stage.CourseStage` has exactly one *canonical*
preset (see :data:`CANONICAL_PRESET_PRACTICES`). A stage may additionally
carry *alternative* presets — extra catalog entries a user can pick
instead — without those alternatives shadowing the canonical pointer in
:data:`STAGE_TO_PRESET_NAME`.

The match key is ``(stage_number, name)`` so a user-submitted practice with
the same display name on a different stage does not block a preset from
being inserted.

``STAGE_TO_PRESET_NAME`` is exported for the frequency-banner endpoint
(ritual-05) which needs to look up "what's the canonical practice for the
user's current stage" without re-encoding the table here.

Call :func:`seed_stages.seed_stages` before this seeder so a ``CourseStage``
row exists for each preset's ``stage_number``. There's no FK from
``Practice.stage_number`` to ``CourseStage.stage_number`` so the seeder
won't crash without it, but downstream readers (e.g. the frequency-banner
endpoint) assume both tables are populated.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.practice import Practice
from schemas.practice_mode_config import ModeConfigAdapter
from seed_practice_copy import PRESET_COPY

#: Nominal ``default_duration_minutes`` for the Dog Walkin' Shamanism
#: preset, which uses ``count_up`` mode and has no real target. The
#: catalog UI hides the duration tile for ``count_up``; this value is a
#: non-null fallback so existing list endpoints don't need to
#: special-case the field.
_COUNT_UP_NOMINAL_DURATION_MINUTES = 20


def _meditation_timer(duration_minutes: float, *, halfway_bell: bool = False) -> dict[str, Any]:
    """Build a meditation_timer ``mode_config`` payload."""
    return {
        "mode": "meditation_timer",
        "duration_minutes": duration_minutes,
        "start_bell": True,
        "halfway_bell": halfway_bell,
        "end_bell": True,
    }


def _sense_grounding_prompts() -> list[dict[str, str]]:
    """5-4-3-2-1 prompts in the order the technique prescribes."""
    return [
        {"sense": "sight", "label": "Name 5 things you can see"},
        {"sense": "touch", "label": "Name 4 things you can touch"},
        {"sense": "hearing", "label": "Name 3 things you can hear"},
        {"sense": "smell", "label": "Name 2 things you can smell"},
        {"sense": "taste", "label": "Name 1 thing you can taste"},
    ]


def _touch_grass_options() -> list[dict[str, str]]:
    """Natural surfaces a user can stand barefoot on for the Touch Grass preset."""
    return [
        {"key": "grass", "label": "Grass", "description": "A lawn, a park, a meadow."},
        {"key": "soil", "label": "Soil", "description": "Garden bed, forest floor, planter."},
        {"key": "sand", "label": "Sand", "description": "A beach or a sandbox."},
        {"key": "stone", "label": "Stone", "description": "Bare rock, a flagstone path."},
    ]


def _mindful_eating_options() -> list[dict[str, str]]:
    """Grounding foods a user can choose for the Mindful Eating preset."""
    return [
        {
            "key": "nuts_seeds",
            "label": "Nuts or seeds",
            "description": "Almonds, walnuts, pumpkin seeds.",
        },
        {
            "key": "root_vegetable",
            "label": "Root vegetable",
            "description": "Carrot, beet, sweet potato.",
        },
        {
            "key": "whole_grain",
            "label": "Whole-grain bread",
            "description": "Dense, hearty, a slow chew.",
        },
        {
            "key": "dark_chocolate",
            "label": "Dark chocolate",
            "description": "A single square, savored.",
        },
        {
            "key": "fresh_fruit",
            "label": "Fresh fruit",
            "description": "Apple, pear, berries.",
        },
    ]


#: Round count shared by the stage-1 tallied-grounding alternatives: the
#: user walks every category three times before the practice completes.
_GROUNDING_ROUNDS = 3

#: Rainbow colours, in spectrum order, for the Find Colors alternative.
#: Each name is also its analytics ``key`` — all match the snake-case
#: ``TalliedCategory.key`` pattern (lowercase letters only).
_RAINBOW_COLORS = ("red", "orange", "yellow", "green", "blue", "indigo", "violet")


def _find_shapes_categories() -> list[dict[str, Any]]:
    """Three geometric-shape categories, three tallies of each per round."""
    return [
        {"key": "squares", "label": "a square", "target_count": 3},
        {"key": "triangles", "label": "a triangle", "target_count": 3},
        {"key": "circles", "label": "a circle", "target_count": 3},
    ]


def _find_colors_categories() -> list[dict[str, Any]]:
    """Seven rainbow-colour categories, one tally of each per round."""
    return [
        {"key": color, "label": f"something {color}", "target_count": 1}
        for color in _RAINBOW_COLORS
    ]


def _build_preset(
    stage_number: int,
    name: str,
    *,
    mode: str,
    mode_config: dict[str, Any],
    default_duration_minutes: float,
) -> dict[str, Any]:
    """Compose one preset row.

    ``name`` must be a key in :data:`PRESET_COPY`; its
    ``(description, instructions)`` tuple supplies the long-form copy.
    """
    description, instructions = PRESET_COPY[name]
    return {
        "stage_number": stage_number,
        "name": name,
        "description": description,
        "instructions": instructions,
        "default_duration_minutes": default_duration_minutes,
        "submitted_by_user_id": None,
        "approved": True,
        "mode": mode,
        "mode_config": mode_config,
    }


#: The one canonical preset per stage. :data:`STAGE_TO_PRESET_NAME` and the
#: frequency-banner endpoint resolve against exactly this list.
_CANONICAL_PRESETS: list[dict[str, Any]] = [
    _build_preset(
        1,
        "5-4-3-2-1 grounding",
        mode="sense_grounding",
        mode_config={"mode": "sense_grounding", "prompts": _sense_grounding_prompts()},
        # Sense-grounding has no clock; carry a small nominal value so the
        # tile shows something sensible until the catalog UI hides it for
        # this mode.
        default_duration_minutes=5,
    ),
    _build_preset(
        2,
        "Tarot meditation",
        mode="tarot",
        mode_config={
            "mode": "tarot",
            "deck": "major_arcana",
            "per_card_minutes": 5,
            "hide_timer_during_meditation": True,
        },
        default_duration_minutes=5,
    ),
    _build_preset(
        3,
        "Belly breathing",
        mode="meditation_timer",
        mode_config=_meditation_timer(10),
        default_duration_minutes=10,
    ),
    _build_preset(
        4,
        "Metta",
        mode="meditation_timer",
        mode_config=_meditation_timer(15, halfway_bell=True),
        default_duration_minutes=15,
    ),
    _build_preset(
        5,
        "Wim Hof method",
        mode="meditation_timer",
        mode_config=_meditation_timer(20),
        default_duration_minutes=20,
    ),
    _build_preset(
        6,
        "Shadow work",
        mode="metronome",
        mode_config={
            "mode": "metronome",
            "bpm": 60,
            "timer": _meditation_timer(30, halfway_bell=True),
        },
        default_duration_minutes=30,
    ),
    _build_preset(
        7,
        "Blissy meditation",
        mode="meditation_timer",
        mode_config=_meditation_timer(45),
        default_duration_minutes=45,
    ),
    _build_preset(
        8,
        "Dog Walkin' Shamanism",
        mode="count_up",
        mode_config={"mode": "count_up", "soft_cap_minutes": None},
        default_duration_minutes=_COUNT_UP_NOMINAL_DURATION_MINUTES,
    ),
    _build_preset(
        9,
        "Concentration practice",
        mode="meditation_timer",
        mode_config=_meditation_timer(45, halfway_bell=True),
        default_duration_minutes=45,
    ),
    _build_preset(
        10,
        "Insight practice",
        mode="meditation_timer",
        mode_config=_meditation_timer(45),
        default_duration_minutes=45,
    ),
]

#: Per-stage alternative presets — extra catalog entries a user may pick
#: instead of the stage's canonical practice. Deliberately excluded from
#: :data:`STAGE_TO_PRESET_NAME` so the frequency banner keeps pointing at
#: the one canonical preset per stage.
_ALTERNATIVE_PRESETS: list[dict[str, Any]] = [
    _build_preset(
        1,
        "Touch Grass",
        mode="mindful_anchor",
        mode_config={
            "mode": "mindful_anchor",
            "instruction": (
                "Stand barefoot on the earth. Notice the texture, "
                "temperature, and pressure under your feet. "
                "Stay until you feel settled."
            ),
            "min_duration_seconds": 120,
            "options": _touch_grass_options(),
            "require_option_choice": True,
        },
        default_duration_minutes=3,
    ),
    _build_preset(
        1,
        "Mindful Eating",
        mode="mindful_anchor",
        mode_config={
            "mode": "mindful_anchor",
            "instruction": (
                "Eat one small portion slowly. Notice texture, "
                "temperature, aroma, and flavor with each bite. "
                "Pause between bites."
            ),
            "min_duration_seconds": 180,
            "options": _mindful_eating_options(),
            "require_option_choice": True,
        },
        default_duration_minutes=5,
    ),
    _build_preset(
        1,
        "Find Shapes",
        mode="tallied_grounding",
        mode_config={
            "mode": "tallied_grounding",
            "rounds": _GROUNDING_ROUNDS,
            "categories": _find_shapes_categories(),
        },
        default_duration_minutes=5,
    ),
    _build_preset(
        1,
        "Find Colors",
        mode="tallied_grounding",
        mode_config={
            "mode": "tallied_grounding",
            "rounds": _GROUNDING_ROUNDS,
            "categories": _find_colors_categories(),
        },
        default_duration_minutes=5,
    ),
    # Stage 1 BEIGE alternatives — body-grounding / nervous-system regulation.
    _build_preset(
        1,
        "Crystal Charging",
        mode="meditation_timer",
        mode_config=_meditation_timer(5),
        default_duration_minutes=5,
    ),
    _build_preset(
        1,
        "Tense and Release",
        mode="meditation_timer",
        mode_config=_meditation_timer(5, halfway_bell=True),
        default_duration_minutes=5,
    ),
    _build_preset(
        1,
        "Contact Points",
        mode="meditation_timer",
        mode_config=_meditation_timer(5),
        default_duration_minutes=5,
    ),
    _build_preset(
        1,
        "Box Breathing",
        mode="meditation_timer",
        mode_config=_meditation_timer(5, halfway_bell=True),
        default_duration_minutes=5,
    ),
    _build_preset(
        1,
        "Toe Wiggling",
        mode="meditation_timer",
        mode_config=_meditation_timer(3),
        default_duration_minutes=3,
    ),
    _build_preset(
        1,
        "Body Scan",
        mode="meditation_timer",
        mode_config=_meditation_timer(5, halfway_bell=True),
        default_duration_minutes=5,
    ),
    _build_preset(
        1,
        "Progressive Muscle Relaxation",
        mode="meditation_timer",
        mode_config=_meditation_timer(10, halfway_bell=True),
        default_duration_minutes=10,
    ),
]

_PRESET_PRACTICES: list[dict[str, Any]] = [*_CANONICAL_PRESETS, *_ALTERNATIVE_PRESETS]


# Validate every preset's mode_config at import time — a typo here crashes
# the seeder (a deliberate, immediate failure) rather than poisoning the DB
# on first startup.
for _preset in _PRESET_PRACTICES:
    ModeConfigAdapter.validate_python(_preset["mode_config"])

# Reject duplicate canonical stage_numbers at import time, mirroring
# seed_stages.py. Alternatives intentionally share a stage with their
# canonical sibling, so the check is scoped to the canonical list.
_stage_numbers = [p["stage_number"] for p in _CANONICAL_PRESETS]
if len(set(_stage_numbers)) != len(_stage_numbers):
    _dupes = sorted(n for n in _stage_numbers if _stage_numbers.count(n) > 1)
    msg = f"Duplicate stage_number among canonical presets: {_dupes}"
    raise ValueError(msg)

# Reject duplicate preset names at import time. ``name`` is the PRESET_COPY
# lookup key, so a collision would silently shadow one preset's copy; it
# also defeats the partial unique index for two presets sharing a stage.
_preset_names = [p["name"] for p in _PRESET_PRACTICES]
if len(set(_preset_names)) != len(_preset_names):
    _name_dupes = sorted(n for n in _preset_names if _preset_names.count(n) > 1)
    msg = f"Duplicate preset name in PRESET_PRACTICES: {_name_dupes}"
    raise ValueError(msg)

#: Immutable view of every preset definition (canonical + alternatives).
#: Tuple (not list) so callers can't accidentally ``.append()`` or
#: ``.clear()`` and silently de-sync :data:`STAGE_TO_PRESET_NAME`.
PRESET_PRACTICES: tuple[dict[str, Any], ...] = tuple(_PRESET_PRACTICES)

#: The one canonical preset per stage. :data:`STAGE_TO_PRESET_NAME` and the
#: frequency-banner endpoint resolve against exactly this subset; per-stage
#: alternatives in :data:`PRESET_PRACTICES` are excluded.
CANONICAL_PRESET_PRACTICES: tuple[dict[str, Any], ...] = tuple(_CANONICAL_PRESETS)

#: Read-only lookup consumed by ritual-05's frequency-banner endpoint.
#: ``MappingProxyType`` forbids mutation so the table can't drift from
#: :data:`CANONICAL_PRESET_PRACTICES` after import.
STAGE_TO_PRESET_NAME: MappingProxyType[int, str] = MappingProxyType(
    {p["stage_number"]: p["name"] for p in CANONICAL_PRESET_PRACTICES}
)


async def _existing_preset_keys(session: AsyncSession) -> set[tuple[int, str]]:
    """Return ``(stage_number, name)`` for every preset already in the DB."""
    result = await session.execute(
        select(Practice.stage_number, Practice.name).where(
            col(Practice.submitted_by_user_id).is_(None)
        )
    )
    return {(row[0], row[1]) for row in result.all()}


async def _commit_or_yield_to_race_winner(session: AsyncSession, inserted: int) -> int:
    """Commit ``inserted`` new rows, treating a unique-index collision as a no-op.

    Race-loser path: a peer process committed the same preset(s) between
    our SELECT and our COMMIT. Roll back and return 0 — the work has
    already been done by the peer. Migration ``d2e3f4a5b6c7`` is what
    makes the database arbitrate; without it both peers would commit and
    we'd ship the duplicate the index was added to prevent.
    """
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        return 0
    return inserted


async def seed_practices(session: AsyncSession) -> int:
    """Insert preset practices that don't already exist by ``(stage, name)``.

    Returns the number of rows inserted. Idempotent: re-running on a
    populated DB returns 0. The existence query filters on
    ``submitted_by_user_id IS NULL`` so user submissions can't shadow a
    preset by colliding on ``(stage_number, name)``.
    """
    existing = await _existing_preset_keys(session)
    inserted = 0
    for definition in PRESET_PRACTICES:
        key = (definition["stage_number"], definition["name"])
        if key in existing:
            continue
        session.add(Practice(**definition))
        inserted += 1
    if not inserted:
        return 0
    return await _commit_or_yield_to_race_winner(session, inserted)
