"""Tests for the practice preset seeder."""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.practice import Practice
from schemas.practice_mode_config import (
    MetronomeConfig,
    ModeConfigAdapter,
    SenseGroundingConfig,
)
from seed_practices import (
    PRESET_PRACTICES,
    STAGE_TO_PRESET_NAME,
    seed_practices,
)
from seed_stages import STAGE_DEFINITIONS

_EXPECTED_PRESET_COUNT = 10
_SENSE_ORDER: tuple[tuple[str, int], ...] = (
    ("sight", 5),
    ("touch", 4),
    ("hearing", 3),
    ("smell", 2),
    ("taste", 1),
)


# -- Seeder behaviour -------------------------------------------------------


@pytest.mark.asyncio
async def test_seed_practices_inserts_all(db_session: AsyncSession) -> None:
    """Empty DB → all 10 presets are inserted; the function returns 10."""
    inserted = await seed_practices(db_session)
    assert inserted == _EXPECTED_PRESET_COUNT

    rows = (await db_session.execute(select(Practice))).scalars().all()
    assert len(rows) == _EXPECTED_PRESET_COUNT


@pytest.mark.asyncio
async def test_seed_practices_idempotent(db_session: AsyncSession) -> None:
    """Re-running on a populated DB inserts nothing and returns 0."""
    first = await seed_practices(db_session)
    second = await seed_practices(db_session)
    assert first == _EXPECTED_PRESET_COUNT
    assert second == 0

    rows = (await db_session.execute(select(Practice))).scalars().all()
    assert len(rows) == _EXPECTED_PRESET_COUNT


@pytest.mark.asyncio
async def test_seed_practices_does_not_collide_with_user_named_practice(
    db_session: AsyncSession,
) -> None:
    """User row with a colliding name on a different stage doesn't block seeder.

    The seeder's match key is ``(stage_number, name)``, not ``name`` alone,
    so a user-submitted practice on stage 999 with the same display name
    as the stage 1 preset must not suppress the stage 1 insert.
    """
    fake = Practice(
        stage_number=999,  # outside the canonical 1..10 range
        name=PRESET_PRACTICES[0]["name"],
        description="user submission",
        instructions="user instructions",
        default_duration_minutes=5,
        approved=True,
        mode="meditation_timer",
        mode_config={
            "mode": "meditation_timer",
            "duration_minutes": 5,
            "start_bell": True,
            "halfway_bell": False,
            "end_bell": True,
        },
    )
    db_session.add(fake)
    await db_session.commit()

    inserted = await seed_practices(db_session)
    assert inserted == _EXPECTED_PRESET_COUNT


# -- Preset data validation -------------------------------------------------


def test_preset_practices_count_matches_stage_total() -> None:
    """One preset per CourseStage row, exactly."""
    assert len(PRESET_PRACTICES) == len(STAGE_DEFINITIONS) == _EXPECTED_PRESET_COUNT


def test_preset_practices_cover_each_stage_once() -> None:
    """Stage numbers 1..10 appear exactly once across the preset list."""
    seen = sorted(p["stage_number"] for p in PRESET_PRACTICES)
    assert seen == list(range(1, _EXPECTED_PRESET_COUNT + 1))


def test_every_preset_mode_config_is_valid() -> None:
    """Each preset round-trips through the ModeConfig discriminated union."""
    for preset in PRESET_PRACTICES:
        cfg_payload = {**preset["mode_config"]}
        cfg = ModeConfigAdapter.validate_python(cfg_payload)
        assert cfg.mode == preset["mode"], (
            f"stage {preset['stage_number']}: parent mode {preset['mode']} "
            f"!= mode_config.mode {cfg.mode}"
        )


def test_every_preset_is_approved_and_unsubmitted() -> None:
    """Presets are catalog rows, not user submissions."""
    for preset in PRESET_PRACTICES:
        assert preset["approved"] is True
        assert preset["submitted_by_user_id"] is None


# -- Per-mode spec checks ---------------------------------------------------


def test_sense_grounding_preset_has_5_4_3_2_1_prompts() -> None:
    """Stage 1's preset implements the 5-4-3-2-1 grounding technique.

    Asserts the sense order from ``_SENSE_ORDER`` and that each label
    contains the expected count token. Pure substring check (no
    ``int()`` parse) so a wording drift fails on a clear assertion
    rather than a silent ``ValueError``.
    """
    preset = next(p for p in PRESET_PRACTICES if p["stage_number"] == 1)
    cfg = SenseGroundingConfig.model_validate(preset["mode_config"])

    assert [p.sense for p in cfg.prompts] == [sense for sense, _ in _SENSE_ORDER]
    for prompt, (_, expected_count) in zip(cfg.prompts, _SENSE_ORDER, strict=True):
        # Match " <count> " (surrounded by whitespace) so "10" wouldn't
        # accidentally satisfy a check for "1".
        assert f" {expected_count} " in f" {prompt.label} ", (
            f"prompt {prompt.label!r} is missing the expected count {expected_count}"
        )


def test_shadow_work_preset_uses_exact_metronome_config() -> None:
    """Stage 6's preset pins the metronome BPM, duration, and halfway bell.

    Exact-value assertions (not range checks) so a mutation that bumps
    BPM 60→200 or duration 30→1 fails loudly — the schema-range checks
    in ``test_every_preset_mode_config_is_valid`` already cover the
    "within bounds" property.
    """
    preset = next(p for p in PRESET_PRACTICES if p["stage_number"] == 6)
    cfg = MetronomeConfig.model_validate(preset["mode_config"])
    assert cfg.bpm == 60
    assert cfg.timer.duration_minutes == 30
    assert cfg.timer.halfway_bell is True


def test_stage_to_preset_name_map_matches_preset_list() -> None:
    """``STAGE_TO_PRESET_NAME`` is the source of truth ritual-05 imports."""
    expected = {p["stage_number"]: p["name"] for p in PRESET_PRACTICES}
    assert expected == STAGE_TO_PRESET_NAME
