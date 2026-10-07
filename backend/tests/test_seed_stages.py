"""Tests for the stage seed script."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from unittest.mock import patch

import pytest
from sqlalchemy import event
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from curriculum.stage_correspondence import (
    CORRESPONDENCE_FIELDS,
    StageCorrespondenceError,
    load_stage_correspondence,
)
from domain.constants import TOTAL_STAGES
from domain.dates import ensure_aware
from models.course_stage import CourseStage
from models.stage_content import StageContent
from scripts.sync_content import read_content_version
from seed_stages import seed_stages, stage_definitions


@pytest.mark.asyncio
async def test_seed_stages_inserts_all(db_session: AsyncSession) -> None:
    """Seeding into an empty DB should insert all 10 stages."""
    inserted = await seed_stages(db_session)
    assert inserted == TOTAL_STAGES

    result = await db_session.execute(select(CourseStage))
    stages = result.scalars().all()
    assert len(stages) == TOTAL_STAGES


@pytest.mark.asyncio
async def test_seed_stages_idempotent(db_session: AsyncSession) -> None:
    """Running seed twice should not duplicate stages."""
    first = await seed_stages(db_session)
    second = await seed_stages(db_session)
    assert first == TOTAL_STAGES
    assert second == 0

    result = await db_session.execute(select(CourseStage))
    stages = result.scalars().all()
    assert len(stages) == TOTAL_STAGES


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
            "When we first move through Beige we operate like a Biological Machine—a bundle of "
            "reflexes, needs, cravings, and instincts. Basically, a baby. An addict deep in the "
            "territory of abuse. A victim of trauma, deprivation, or circumstance struggling to "
            "survive. It\u2019s not something to feel guilty about."
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
        "relationship_to_free_will": "Pleasure Seeker",
        "free_will_description": (
            "Behavior is steered from the Sacral: toward what feels nice and away from what "
            "doesn't, before any argument has been made. Much of what feels nice was installed "
            "by inherited stories and by people with an interest in what you reach for, so "
            "pleasure is at once real information and an easy leash. Free Will here is not "
            "renouncing pleasure or obeying it, but learning to tell the yes that widens you "
            "from the yes that narrows you."
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
            "APTITUDE teaches that Free Will only becomes real when you learn to express power "
            "differently. The Dominator believes they are acting freely, but in truth, they are "
            'ruled by fear and shame. Their "choices" are reactions. Their "power" is armor.'
        ),
    },
    {
        "stage_number": 4,
        "title": "Conformity",
        "subtitle": "Community Love",
        "overview_url": "",
        "category": "Love",
        "aspect": "Community Love",
        "spiral_dynamics_color": "Blue",
        "growing_up_stage": "Conformity",
        "divine_gender_polarity": "Divine Feminine",
        "relationship_to_free_will": "Victim",
        "free_will_description": (
            "At Blue, you do what you're told. You follow the rules. You meet the expectations."
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
            "Here's the truth: recognizing that you've been conditioned is not the same as "
            "freeing yourself from that conditioning. Naming your trauma is not the same as "
            "healing it. Understanding why you're afraid doesn't make you brave."
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
            "Yellow is where you start to see the forces. Where you develop enough metacognitive "
            "capacity to observe your own patterns as they arise. And from that observation, you "
            "gain the smallest sliver of space—the gap between impulse and action. And in that "
            "gap, choice becomes possible."
        ),
    },
    {
        "stage_number": 8,
        "title": "True Self Connection",
        "subtitle": "True Self Wisdom",
        "overview_url": "",
        "category": "Wisdom",
        "aspect": "True Self Connection",
        "spiral_dynamics_color": "Teal",
        "growing_up_stage": "True Self Connection",
        "divine_gender_polarity": "Divine Feminine",
        "relationship_to_free_will": "True Self Embodier",
        "free_will_description": (
            "The part of you that chose to incarnate into these conditions. The part that has a "
            "purpose, a mission, a knowing that the personality cannot access through effort alone."
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
            "At Clear Light, the question of Free Will dissolves. Not because it's been answered, "
            'but because it\'s been seen through. There is no "you" to have free will. And yet, '
            "choice is obviously happening. Actions arise. Intentions form. Life unfolds."
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
    """``stage_definitions()`` must equal the canonical golden literal, field for field.

    Guards against the stage-correspondence artifact (and the curriculum
    dataset that still supplies titles) drifting away from the canonical
    APTITUDE stage ontology the definitions are derived from. Stage 2's
    description is the Complete Map CSV's own sentence since #2664 vendored
    the CSV, as ``archetypal_wavelength.json``'s provenance anticipated.
    """
    assert len(stage_definitions()) == len(_GOLDEN_STAGE_DEFINITIONS)

    actual_by_number = {d["stage_number"]: d for d in stage_definitions()}
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
    # Discard anything seed_stages left unflushed or uncommitted, so the
    # re-read below sees only what reached the database.
    await db_session.rollback()

    refreshed = await _fetch_stage(db_session, 1)
    assert refreshed.id == original_id
    assert refreshed.aspect == "Agency"
    assert refreshed.spiral_dynamics_color == "Beige"
    assert refreshed.category == "Yes-And-Ness"

    result = await db_session.execute(select(CourseStage))
    assert len(result.scalars().all()) == TOTAL_STAGES


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
    # Discard anything seed_stages left unflushed or uncommitted, so the
    # re-read below sees only what reached the database.
    await db_session.rollback()

    refreshed = await _fetch_stage(db_session, 1)
    assert refreshed.aspect == "Agency"
    assert refreshed.overview_url == "https://example.test/stage-1"


#: Stage 2's free-will archetype as the dataset carried it before #2915
#: corrected it to the course's "Pleasure Seeker".  It survives only here, as
#: the value an already-seeded database still holds on its first boot after the
#: fix; the corrected value is read from :func:`stage_definitions`, never retyped.
_RETIRED_STAGE_2_ARCHETYPE = "Archetype Embodier"

#: Stage 2's pre-#2915 free-will description (backup-era habits/personalities
#: prose), paired with :data:`_RETIRED_STAGE_2_ARCHETYPE`.
_RETIRED_STAGE_2_DESCRIPTION = (
    "Individual personalities (collections of habits—which are frequently repeated "
    "behaviors) are the combined effort of archetypal role models, including everything "
    "from fictional characters to societal celebrities (and perhaps ancient gods in "
    "polytheistic cultures)"
)

_STAGE_2 = 2


@pytest.mark.asyncio
async def test_seed_stages_corrects_retired_stage_2_free_will(db_session: AsyncSession) -> None:
    """A stage-2 row seeded before #2915 is rewritten to the course archetype on boot."""
    await seed_stages(db_session)
    row = await _fetch_stage(db_session, _STAGE_2)
    original_id = row.id
    row.relationship_to_free_will = _RETIRED_STAGE_2_ARCHETYPE
    row.free_will_description = _RETIRED_STAGE_2_DESCRIPTION
    row.overview_url = "https://example.test/stage-2"
    await db_session.commit()

    reinserted = await seed_stages(db_session)
    # Discard anything seed_stages left unflushed or uncommitted, so the
    # re-read below sees only what reached the database.
    await db_session.rollback()

    assert reinserted == 0
    definition = next(d for d in stage_definitions() if d["stage_number"] == _STAGE_2)
    refreshed = await _fetch_stage(db_session, _STAGE_2)
    assert refreshed.id == original_id
    assert refreshed.relationship_to_free_will == definition["relationship_to_free_will"]
    assert refreshed.relationship_to_free_will != _RETIRED_STAGE_2_ARCHETYPE
    assert refreshed.free_will_description == definition["free_will_description"]
    assert refreshed.free_will_description != _RETIRED_STAGE_2_DESCRIPTION
    assert refreshed.overview_url == "https://example.test/stage-2"


_CONTENT_DIR = Path(__file__).resolve().parents[1] / "content"
_ARTIFACT_PATH = (
    Path(__file__).resolve().parents[1] / "src" / "curriculum" / "stage_correspondence.json"
)
_PINNED_SHA = "9d0f8962ef7b2f096ed1b5bb5d031df79e309d20"  # pragma: allowlist secret
_SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")


@pytest.mark.asyncio
async def test_seed_stages_records_stable_key_and_provenance(db_session: AsyncSession) -> None:
    """A fresh seed stamps every Stage with its colour-slug key and the artifact's source."""
    await seed_stages(db_session)

    rows = (
        (await db_session.execute(select(CourseStage).order_by(col(CourseStage.stage_number))))
        .scalars()
        .all()
    )
    artifact_source = json.loads(_ARTIFACT_PATH.read_text())["source"]

    assert len(rows) == TOTAL_STAGES
    assert [r.stage_key for r in rows] == [
        "beige",
        "purple",
        "red",
        "blue",
        "orange",
        "green",
        "yellow",
        "teal",
        "ultraviolet",
        "clearlight",
    ]
    assert read_content_version(_CONTENT_DIR)["sha"] == _PINNED_SHA
    for row in rows:
        assert row.source_sha == _PINNED_SHA
        assert row.artifact_schema_version == "1.0.0"
        assert row.source_sha256 is not None
        assert _SHA256_HEX.fullmatch(row.source_sha256)
        assert row.source_sha256 == artifact_source["sha256"]


# --- #2665: reconcile by stable key, provenance, rollback ---------------------

_STAGE_KEYS_LITERAL = (
    "beige",
    "purple",
    "red",
    "blue",
    "orange",
    "green",
    "yellow",
    "teal",
    "ultraviolet",
    "clearlight",
)
_BLUE = 4
_TEAL = 8
_ORPHAN_STAGE_NUMBER = 11
_STALE_SHA = "0" * 40
_STALE_SHA256 = "f" * 64
_DRIFTED_ASPECT = "Drifted Aspect"
_IGNORED_COLUMNS = frozenset({"id", "reconciled_at"})


def _row_contents(row: CourseStage) -> dict[str, object]:
    """Every persisted column of ``row`` except the surrogate id and timestamp."""
    return {name: value for name, value in row.model_dump().items() if name not in _IGNORED_COLUMNS}


async def _all_rows(session: AsyncSession) -> list[CourseStage]:
    """Every CourseStage row, in stage order."""
    result = await session.execute(
        select(CourseStage).order_by(col(CourseStage.stage_number), col(CourseStage.id))
    )
    return list(result.scalars().all())


def _artifact_stage(stage_key: str) -> dict[str, object]:
    """The committed artifact's raw entry for ``stage_key``."""
    stages: list[dict[str, object]] = json.loads(_ARTIFACT_PATH.read_text())["stages"]
    return next(entry for entry in stages if entry["id"] == stage_key)


@pytest.mark.asyncio
async def test_a_fresh_seed_matches_the_artifact_field_by_field(db_session: AsyncSession) -> None:
    """Each row carries its artifact entry's seven fields and the artifact's source."""
    await seed_stages(db_session)
    source = json.loads(_ARTIFACT_PATH.read_text())["source"]

    for row in await _all_rows(db_session):
        assert row.stage_key is not None
        entry = _artifact_stage(row.stage_key)
        assert row.stage_number == entry["stage_number"]
        for field in CORRESPONDENCE_FIELDS:
            assert getattr(row, field) == entry[field], (row.stage_key, field)
        assert row.source_repo == source["repo"]
        assert row.source_path == source["csv_path"]
        assert row.reconciled_at is not None
        assert row.overview_url == ""


@pytest.mark.asyncio
async def test_supersessions_reach_the_seeded_rows(db_session: AsyncSession) -> None:
    """The ratified departures from the CSV are what the database holds."""
    await seed_stages(db_session)

    assert (await _fetch_stage(db_session, _BLUE)).aspect == "Community Love"
    assert (await _fetch_stage(db_session, _TEAL)).relationship_to_free_will == (
        "True Self Embodier"
    )


async def _fresh_seed_contents(session: AsyncSession) -> list[dict[str, object]]:
    """Seed an emptied table and return its rows' contents."""
    for row in await _all_rows(session):
        await session.delete(row)
    await session.commit()
    await seed_stages(session)
    return [_row_contents(row) for row in await _all_rows(session)]


@pytest.mark.asyncio
async def test_two_fresh_seeds_are_identical(db_session: AsyncSession) -> None:
    """Determinism: the same artifact always yields the same rows."""
    first = await _fresh_seed_contents(db_session)
    second = await _fresh_seed_contents(db_session)

    assert len(first) == TOTAL_STAGES
    assert first == second


class _StatementLog:
    """Collects the DML statements a connection sends while attached."""

    def __init__(self) -> None:
        self.statements: list[str] = []

    def __call__(self, *args: object) -> None:
        statement = str(args[2]).lstrip().upper()
        if statement.startswith(("INSERT", "UPDATE", "DELETE")):
            self.statements.append(statement)


@pytest.mark.asyncio
async def test_an_unchanged_reseed_is_a_true_no_op(db_session: AsyncSession) -> None:
    """No insert, no UPDATE, no commit, and no timestamp moves."""
    await seed_stages(db_session)
    before = {row.stage_key: row.reconciled_at for row in await _all_rows(db_session)}
    engine = (await db_session.connection()).engine.sync_engine
    log = _StatementLog()
    event.listen(engine, "before_cursor_execute", log)
    try:
        with patch.object(db_session, "commit", wraps=db_session.commit) as commit:
            inserted = await seed_stages(db_session)
    finally:
        event.remove(engine, "before_cursor_execute", log)

    assert inserted == 0
    assert log.statements == []
    commit.assert_not_awaited()
    rows = await _all_rows(db_session)
    assert len(rows) == TOTAL_STAGES
    assert {row.stage_key: row.reconciled_at for row in rows} == before


@pytest.mark.asyncio
async def test_reconcile_by_key_restores_fields_and_provenance_in_place(
    db_session: AsyncSession,
) -> None:
    """Drifted values and stale provenance are corrected on the same row id."""
    await seed_stages(db_session)
    blue = await _fetch_stage(db_session, _BLUE)
    original_id = blue.id
    untouched_before = (await _fetch_stage(db_session, 1)).reconciled_at
    blue_before = blue.reconciled_at
    content = StageContent(
        course_stage_id=original_id,
        title="Chapter",
        content_type="essay",
        release_day=0,
        url="content://blue/chapter",
    )
    db_session.add(content)
    blue.aspect = _DRIFTED_ASPECT
    blue.source_sha = _STALE_SHA
    blue.source_sha256 = _STALE_SHA256
    await db_session.commit()

    inserted = await seed_stages(db_session)
    await db_session.rollback()

    assert inserted == 0
    refreshed = await _fetch_stage(db_session, _BLUE)
    assert refreshed.id == original_id
    assert refreshed.aspect == "Community Love"
    assert refreshed.source_sha == _PINNED_SHA
    assert refreshed.source_sha256 == json.loads(_ARTIFACT_PATH.read_text())["source"]["sha256"]
    assert refreshed.reconciled_at is not None
    assert blue_before is not None
    assert ensure_aware(refreshed.reconciled_at) > ensure_aware(blue_before)
    untouched_after = (await _fetch_stage(db_session, 1)).reconciled_at
    assert untouched_before is not None
    assert untouched_after is not None
    assert ensure_aware(untouched_after) == ensure_aware(untouched_before)
    assert len(await _all_rows(db_session)) == TOTAL_STAGES
    await db_session.refresh(content)
    assert content.course_stage_id == original_id


@pytest.mark.asyncio
async def test_a_row_outside_the_artifact_is_kept_and_warned_about(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    """Non-destructive: an orphan is logged, never deleted."""
    await seed_stages(db_session)
    template = _row_contents(await _fetch_stage(db_session, 1))
    orphan = CourseStage(**{**template, "stage_key": None, "stage_number": _ORPHAN_STAGE_NUMBER})
    db_session.add(orphan)
    await db_session.commit()
    caplog.set_level(logging.WARNING, logger="seed_stages")

    await seed_stages(db_session)

    rows = await _all_rows(db_session)
    assert len(rows) == TOTAL_STAGES + 1
    assert rows[-1].stage_key == f"stage-{_ORPHAN_STAGE_NUMBER}"
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert warnings == [
        f"stage_orphaned stage_key=stage-{_ORPHAN_STAGE_NUMBER} stage_number={_ORPHAN_STAGE_NUMBER}"
    ]


@pytest.mark.asyncio
async def test_a_key_number_mismatch_raises_before_any_write(db_session: AsyncSession) -> None:
    """A row whose key and number disagree is an integrity fault, not a race."""
    await seed_stages(db_session)
    blue = await _fetch_stage(db_session, _BLUE)
    orange = await _fetch_stage(db_session, _BLUE + 1)
    blue.stage_key, orange.stage_key = "swap-placeholder", "blue"
    await db_session.flush()
    blue.stage_key = "orange"
    orange.aspect = _DRIFTED_ASPECT
    await db_session.commit()
    before = [_row_contents(row) for row in await _all_rows(db_session)]

    with pytest.raises(
        StageCorrespondenceError,
        match="stage_key 'blue' is stage_number 5 in the database but 4 in the artifact",
    ):
        await seed_stages(db_session)

    assert [_row_contents(row) for row in await _all_rows(db_session)] == before


def _broken_artifact(tmp_path: Path, breakage: str) -> Path:
    """Write a copy of the committed artifact damaged in one named way."""
    payload = json.loads(_ARTIFACT_PATH.read_text())
    if breakage == "duplicate":
        payload["stages"][_BLUE - 1] = dict(payload["stages"][_BLUE - 2])
    elif breakage == "missing":
        payload["stages"] = payload["stages"][:-1]
    elif breakage == "version":
        payload["schema_version"] = "9.9.9"
    path = tmp_path / "stage_correspondence.json"
    text = json.dumps(payload)
    path.write_text(text[: len(text) // 2] if breakage == "malformed" else text)
    return path


@pytest.mark.asyncio
@pytest.mark.parametrize("breakage", ["malformed", "duplicate", "missing", "version"])
async def test_a_bad_artifact_raises_and_leaves_the_table_unchanged(
    db_session: AsyncSession, tmp_path: Path, breakage: str
) -> None:
    """The load fails before the seeder reads or writes a single row."""
    await seed_stages(db_session)
    drifted = await _fetch_stage(db_session, _BLUE)
    drifted.aspect = _DRIFTED_ASPECT
    await db_session.commit()
    before = [_row_contents(row) for row in await _all_rows(db_session)]
    path = _broken_artifact(tmp_path, breakage)

    with pytest.raises(StageCorrespondenceError):
        await seed_stages(db_session, load=lambda: load_stage_correspondence(path))

    assert [_row_contents(row) for row in await _all_rows(db_session)] == before


@pytest.mark.asyncio
async def test_a_commit_failure_leaves_no_partial_update(db_session: AsyncSession) -> None:
    """A non-race failure at commit rolls the reconcile back and propagates."""
    await seed_stages(db_session)
    drifted = await _fetch_stage(db_session, _BLUE)
    drifted.aspect = _DRIFTED_ASPECT
    drifted.source_sha = _STALE_SHA
    await db_session.commit()

    async def _flush_then_fail(session: AsyncSession, _inserted: int) -> int:
        await session.flush()
        raise OperationalError("COMMIT", {}, Exception("disk I/O error"))

    with (
        patch("seed_stages.commit_or_yield_to_race_winner", new=_flush_then_fail),
        pytest.raises(OperationalError),
    ):
        await seed_stages(db_session)

    refreshed = await _fetch_stage(db_session, _BLUE)
    assert refreshed.aspect == _DRIFTED_ASPECT
    assert refreshed.source_sha == _STALE_SHA


@pytest.mark.asyncio
async def test_a_partial_table_is_completed_without_touching_present_rows(
    db_session: AsyncSession,
) -> None:
    """Missing Stages are inserted; the present ones keep their ids."""
    await seed_stages(db_session)
    rows = await _all_rows(db_session)
    kept_ids = {row.stage_key: row.id for row in rows[:_BLUE]}
    for row in rows[_BLUE:]:
        await db_session.delete(row)
    await db_session.commit()

    inserted = await seed_stages(db_session)

    assert inserted == TOTAL_STAGES - _BLUE
    refreshed = await _all_rows(db_session)
    assert [row.stage_key for row in refreshed] == list(_STAGE_KEYS_LITERAL)
    assert {row.stage_key: row.id for row in refreshed[:_BLUE]} == kept_ids
