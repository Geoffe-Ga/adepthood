"""Seed script for the 10 stage-aligned default :class:`Practice` rows.

Mirrors :mod:`seed_stages` — defines the canonical preset list, validates
each ``mode_config`` payload at import time so a typo crashes the seeder
(not the runtime), and inserts only what is missing on a per-call basis.

The match key is ``(stage_number, name)`` so a user-submitted practice with
the same display name on a different stage does not block a preset from
being inserted.

``STAGE_TO_PRESET_NAME`` is exported for the frequency-banner endpoint
(ritual-05) which needs to look up "what's the canonical practice for the
user's current stage" without re-encoding the table here.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.practice import Practice
from schemas.practice_mode_config import ModeConfigAdapter
from seed_practice_copy import PRESET_COPY


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


def _build_preset(
    stage_number: int,
    name: str,
    *,
    mode: str,
    mode_config: dict[str, Any],
    default_duration_minutes: float,
) -> dict[str, Any]:
    """Compose one preset row, drawing description / instructions from copy."""
    description, instructions = PRESET_COPY[stage_number]
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


_PRESET_PRACTICES: list[dict[str, Any]] = [
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
        # Count-up has no target; carry a nominal default for the tile.
        default_duration_minutes=20,
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


# Validate every preset's mode_config at import time — a typo here crashes
# the seeder (a deliberate, immediate failure) rather than poisoning the DB
# on first startup.
for _preset in _PRESET_PRACTICES:
    ModeConfigAdapter.validate_python(_preset["mode_config"])

# Reject duplicate stage_numbers at import time, mirroring seed_stages.py.
_stage_numbers = [p["stage_number"] for p in _PRESET_PRACTICES]
if len(set(_stage_numbers)) != len(_stage_numbers):
    _dupes = sorted(n for n in _stage_numbers if _stage_numbers.count(n) > 1)
    msg = f"Duplicate stage_number in PRESET_PRACTICES: {_dupes}"
    raise ValueError(msg)

PRESET_PRACTICES = _PRESET_PRACTICES

#: Lookup table consumed by ritual-05's frequency-banner endpoint.
STAGE_TO_PRESET_NAME: dict[int, str] = {p["stage_number"]: p["name"] for p in PRESET_PRACTICES}


async def seed_practices(session: AsyncSession) -> int:
    """Insert preset practices that don't already exist by ``(stage, name)``.

    Returns the number of rows inserted. Idempotent: re-running on a
    populated DB returns 0.
    """
    result = await session.execute(select(Practice.stage_number, Practice.name))
    existing: set[tuple[int, str]] = {(row[0], row[1]) for row in result.all()}

    inserted = 0
    for definition in PRESET_PRACTICES:
        key = (definition["stage_number"], definition["name"])
        if key in existing:
            continue
        session.add(Practice(**definition))
        inserted += 1

    if inserted:
        await session.commit()
    return inserted
