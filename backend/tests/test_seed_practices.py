"""Tests for the practice preset seeder."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.practice import Practice
from schemas.practice_mode_config import (
    MetronomeConfig,
    MindfulAnchorConfig,
    ModeConfigAdapter,
    SenseGroundingConfig,
)
from seed_practices import (
    CANONICAL_PRESET_PRACTICES,
    PRESET_PRACTICES,
    STAGE_TO_PRESET_NAME,
    seed_practices,
)
from seed_stages import STAGE_DEFINITIONS

#: Total catalog presets the seeder inserts. Derived from the source list
#: so adding a preset never silently drifts these expectations — mirrors
#: the dynamic count in ``test_lifespan_seeding.py``.
_EXPECTED_PRESET_COUNT = len(PRESET_PRACTICES)
#: Stage number outside the canonical 1..10 range. Used by the
#: name-collision test to plant a user submission that the seeder must
#: ignore — the bare ``Practice`` model has no FK or range check on
#: ``stage_number``, so any out-of-range integer works.
_OUT_OF_RANGE_STAGE = 999
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
    """Empty DB → every preset is inserted; the function returns the count."""
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
async def test_preset_unique_index_rejects_duplicate_seed_insert(
    db_session: AsyncSession,
) -> None:
    """The partial unique index closes the seeder race.

    Without the index, two concurrent ``lifespan`` runs can each pass the
    existence SELECT before either commits, double-inserting every preset.
    This test simulates the race by attempting two raw INSERTs of the same
    preset row and verifies the DB rejects the second with ``IntegrityError``.
    """
    first = Practice(**PRESET_PRACTICES[0])
    db_session.add(first)
    await db_session.commit()

    # Same (stage_number, name) with submitted_by_user_id IS NULL — must fail.
    dupe = Practice(**PRESET_PRACTICES[0])
    db_session.add(dupe)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_preset_unique_index_is_case_and_whitespace_insensitive(
    db_session: AsyncSession,
) -> None:
    """``lower(trim(name))`` collapses "5-4-3-2-1 grounding" / "  5-4-3-2-1 Grounding"."""
    first = Practice(**PRESET_PRACTICES[0])
    db_session.add(first)
    await db_session.commit()

    raw_name = PRESET_PRACTICES[0]["name"]
    skewed = Practice(
        **{
            **PRESET_PRACTICES[0],
            "name": f"  {raw_name.upper()}  ",
        }
    )
    db_session.add(skewed)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_preset_unique_index_allows_user_submission_with_same_name(
    db_session: AsyncSession,
) -> None:
    """The partial ``WHERE submitted_by_user_id IS NULL`` clause exempts user submissions.

    A user submitting their own practice with the same display name as a
    preset is a legitimate scenario the index must NOT reject.
    """
    preset = Practice(**PRESET_PRACTICES[0])
    db_session.add(preset)
    await db_session.commit()

    # Carry a synthetic user id. The model declares a FK to ``user.id`` but
    # SQLite's FK enforcement is off by default in tests; the relevant
    # contract here is that any non-null value falls outside the partial
    # index's ``WHERE submitted_by_user_id IS NULL`` predicate.
    user_submission = Practice(
        **{**PRESET_PRACTICES[0], "submitted_by_user_id": 12_345, "approved": False}
    )
    db_session.add(user_submission)
    await db_session.commit()  # MUST NOT raise


@pytest.mark.asyncio
async def test_seed_practices_skips_already_seeded_preset(
    db_session: AsyncSession,
) -> None:
    """A pre-seeded preset is skipped by the existence-check pre-pass.

    This is the idempotency path the seeder is designed around: if any
    preset is already in the DB, the SELECT in ``_existing_preset_keys``
    finds it, ``seed_practices`` doesn't try to insert it, and only the
    missing rows land.
    """
    db_session.add(Practice(**PRESET_PRACTICES[0]))
    await db_session.commit()

    inserted = await seed_practices(db_session)
    assert inserted == _EXPECTED_PRESET_COUNT - 1


@pytest.mark.asyncio
async def test_seed_practices_race_loser_returns_zero(
    db_session: AsyncSession,
) -> None:
    """The actual race-loser path: SELECT misses, COMMIT loses the race.

    Reproduces the production scenario by patching ``_existing_preset_keys``
    to return an empty set — the seeder then stages every preset for insert,
    but the row(s) the "race-winner" peer already committed make the unique
    index fire on commit. ``_commit_or_yield_to_race_winner`` catches the
    ``IntegrityError``, rolls back, and returns 0.

    This is the only test that actually exercises the ``except IntegrityError``
    branch — the previous ``test_seed_practices_skips_already_seeded_preset``
    short-circuits before reaching it via the pre-pass.
    """
    # Simulate the race-winner peer's commit landing first.
    for definition in PRESET_PRACTICES:
        db_session.add(Practice(**definition))
    await db_session.commit()

    # Patch the existence check to claim the table is empty so the seeder
    # actually attempts every insert — the DB unique index is the only
    # arbiter, just like the production race.
    with patch("seed_practices._existing_preset_keys", new=AsyncMock(return_value=set())):
        result = await seed_practices(db_session)

    assert result == 0
    # The original 10 rows are still the only ones in the DB — no duplicate
    # leaked past the rollback.
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
        stage_number=_OUT_OF_RANGE_STAGE,
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


async def _seed_and_fetch(db_session: AsyncSession, name: str) -> Practice:
    """Run the seeder, then return the single ``Practice`` row named ``name``."""
    await seed_practices(db_session)
    result = await db_session.execute(select(Practice).where(Practice.name == name))
    return result.scalars().one()


@pytest.mark.asyncio
async def test_touch_grass_preset_seeds(db_session: AsyncSession) -> None:
    """Touch Grass seeds as a stage-1 mindful_anchor preset with 4 anchor options."""
    row = await _seed_and_fetch(db_session, "Touch Grass")

    assert row.stage_number == 1
    assert row.mode == "mindful_anchor"
    assert row.description
    assert row.instructions

    cfg = MindfulAnchorConfig.model_validate(row.mode_config)
    assert [opt.key for opt in cfg.options] == ["grass", "soil", "sand", "stone"]
    assert cfg.require_option_choice is True
    assert cfg.min_duration_seconds == 120
    assert all(opt.description for opt in cfg.options)


@pytest.mark.asyncio
async def test_mindful_eating_preset_seeds(db_session: AsyncSession) -> None:
    """Mindful Eating seeds as a mindful_anchor preset with 5 options and a 180s floor."""
    row = await _seed_and_fetch(db_session, "Mindful Eating")

    assert row.stage_number == 1
    assert row.mode == "mindful_anchor"

    cfg = MindfulAnchorConfig.model_validate(row.mode_config)
    assert [opt.key for opt in cfg.options] == [
        "nuts_seeds",
        "root_vegetable",
        "whole_grain",
        "dark_chocolate",
        "fresh_fruit",
    ]
    assert cfg.instruction.strip() != ""
    assert cfg.min_duration_seconds == 180
    assert cfg.require_option_choice is True


@pytest.mark.asyncio
async def test_seed_is_idempotent_with_new_presets(db_session: AsyncSession) -> None:
    """Re-running the seeder leaves exactly one row for each mindful_anchor preset."""
    first = await seed_practices(db_session)
    second = await seed_practices(db_session)
    assert first == _EXPECTED_PRESET_COUNT
    assert second == 0

    for name in ("Touch Grass", "Mindful Eating"):
        result = await db_session.execute(select(Practice).where(Practice.name == name))
        assert len(result.scalars().all()) == 1


# -- Preset data validation -------------------------------------------------


def test_canonical_presets_match_stage_total() -> None:
    """Exactly one canonical preset per CourseStage row.

    The full :data:`PRESET_PRACTICES` list is larger than the stage count
    because a stage may carry alternative presets alongside its canonical
    one; the canonical subset stays 1:1 with the stages.
    """
    assert len(CANONICAL_PRESET_PRACTICES) == len(STAGE_DEFINITIONS)
    assert len(PRESET_PRACTICES) > len(CANONICAL_PRESET_PRACTICES)


def test_canonical_presets_cover_each_stage_once() -> None:
    """Stage numbers 1..10 appear exactly once across the canonical presets."""
    seen = sorted(p["stage_number"] for p in CANONICAL_PRESET_PRACTICES)
    assert seen == list(range(1, len(STAGE_DEFINITIONS) + 1))


def test_every_preset_sits_on_a_known_stage() -> None:
    """Every preset — canonical or alternative — lands on a defined stage."""
    valid_stages = set(range(1, len(STAGE_DEFINITIONS) + 1))
    for preset in PRESET_PRACTICES:
        assert preset["stage_number"] in valid_stages


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


def test_stage_to_preset_name_map_matches_canonical_presets() -> None:
    """``STAGE_TO_PRESET_NAME`` is the canonical-preset table ritual-05 imports."""
    expected = {p["stage_number"]: p["name"] for p in CANONICAL_PRESET_PRACTICES}
    assert expected == STAGE_TO_PRESET_NAME


def test_alternative_presets_never_shadow_the_canonical_pointer() -> None:
    """Touch Grass / Mindful Eating sit on stage 1 but never become its canonical preset.

    They are seeded into the catalog (so the chooser can offer them) yet
    excluded from ``STAGE_TO_PRESET_NAME`` so the frequency-banner endpoint
    keeps resolving stage 1 to the canonical 5-4-3-2-1 grounding preset.
    """
    alternative_names = {"Touch Grass", "Mindful Eating"}
    all_names = {p["name"] for p in PRESET_PRACTICES}
    canonical_names = {p["name"] for p in CANONICAL_PRESET_PRACTICES}
    assert alternative_names <= all_names
    assert alternative_names.isdisjoint(canonical_names)
    assert alternative_names.isdisjoint(STAGE_TO_PRESET_NAME.values())
    assert STAGE_TO_PRESET_NAME[1] == "5-4-3-2-1 grounding"
