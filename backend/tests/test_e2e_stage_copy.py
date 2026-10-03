"""The e2e lane's stage-copy arrange rewrites only whitelisted copy, or fails loudly."""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models import CourseStage
from tests.e2e.stage_copy import (
    SET_FIELD_COMMAND,
    SET_SUBTITLE_COMMAND,
    SETTABLE_FIELDS,
    StageCopyError,
    _build_parser,
    _select_operation,
    set_field,
)

STAGE = 2
PERSONA = "relationship_to_free_will"
SEEDED_PERSONA = "Pleasure Seeker"
SEEDED_SUBTITLE = "Passive Yes-And-Ness"
SENTINEL = "Rewritten Archetype"


async def _seed_stage(session: AsyncSession) -> CourseStage:
    """A ``coursestage`` row for stage 2 with known copy."""
    row = CourseStage(
        title="Magick",
        subtitle=SEEDED_SUBTITLE,
        stage_number=STAGE,
        overview_url="",
        category="Yes-And-Ness",
        aspect="Receptivity",
        spiral_dynamics_color="Purple",
        growing_up_stage="Magic",
        divine_gender_polarity="Divine Feminine",
        relationship_to_free_will=SEEDED_PERSONA,
        free_will_description="Behavior is steered from the Sacral.",
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def _stored(session: AsyncSession) -> CourseStage:
    """The stage-2 row as the database now holds it."""
    session.expire_all()
    result = await session.execute(select(CourseStage).where(CourseStage.stage_number == STAGE))
    return result.scalars().one()


def test_only_the_subtitle_and_the_persona_are_settable() -> None:
    """The whitelist is exactly the two fields a spec rewrites."""
    assert SETTABLE_FIELDS == ("subtitle", PERSONA)


@pytest.mark.asyncio
async def test_set_field_rewrites_the_persona_and_reports_what_it_replaced(
    db_session: AsyncSession,
) -> None:
    """The persona moves, the report names the old value, and nothing else moves."""
    await _seed_stage(db_session)

    payload = await set_field(db_session, STAGE, PERSONA, SENTINEL)

    assert payload == {
        "stage_number": STAGE,
        "field": PERSONA,
        "value": SENTINEL,
        "previous": SEEDED_PERSONA,
    }
    stored = await _stored(db_session)
    assert stored.relationship_to_free_will == SENTINEL
    assert stored.subtitle == SEEDED_SUBTITLE
    assert stored.aspect == "Receptivity"


@pytest.mark.asyncio
async def test_set_field_round_trips_back_to_the_seeded_value(db_session: AsyncSession) -> None:
    """Writing the reported previous value restores the row."""
    await _seed_stage(db_session)
    written = await set_field(db_session, STAGE, PERSONA, SENTINEL)

    restored = await set_field(db_session, STAGE, PERSONA, str(written["previous"]))

    assert restored["value"] == SEEDED_PERSONA
    assert (await _stored(db_session)).relationship_to_free_will == SEEDED_PERSONA


@pytest.mark.asyncio
async def test_set_field_refuses_a_field_off_the_whitelist(db_session: AsyncSession) -> None:
    """A column the spec has no business moving is refused before anything is written."""
    await _seed_stage(db_session)
    with pytest.raises(StageCopyError, match="aspect"):
        await set_field(db_session, STAGE, "aspect", SENTINEL)
    assert (await _stored(db_session)).aspect == "Receptivity"


@pytest.mark.asyncio
@pytest.mark.parametrize("blank", ["", "   "])
async def test_set_field_refuses_a_blank_value(db_session: AsyncSession, blank: str) -> None:
    """A blank value would make the spec's assertion vacuous."""
    await _seed_stage(db_session)
    with pytest.raises(StageCopyError, match="blank"):
        await set_field(db_session, STAGE, PERSONA, blank)
    assert (await _stored(db_session)).relationship_to_free_will == SEEDED_PERSONA


@pytest.mark.asyncio
async def test_set_field_refuses_a_stage_no_row_holds(db_session: AsyncSession) -> None:
    """An unknown stage number fails loudly rather than arranging nothing."""
    with pytest.raises(StageCopyError, match="numbered 2"):
        await set_field(db_session, STAGE, PERSONA, SENTINEL)


def test_the_parser_offers_set_field_with_a_field_whitelist() -> None:
    """``--field`` is limited to the whitelist at the command line too."""
    parser = _build_parser()
    args = parser.parse_args(
        [SET_FIELD_COMMAND, "--stage", "2", "--field", PERSONA, "--value", SENTINEL]
    )
    assert _select_operation(args) is not None
    with pytest.raises(SystemExit):
        parser.parse_args(
            [SET_FIELD_COMMAND, "--stage", "2", "--field", "aspect", "--value", SENTINEL]
        )


def test_set_subtitle_still_parses_as_before() -> None:
    """The stage-copy spec's existing subcommand keeps working."""
    args = _build_parser().parse_args(
        [SET_SUBTITLE_COMMAND, "--stage", "5", "--subtitle", "New words"]
    )
    assert _select_operation(args) is not None


def test_a_blank_value_is_refused_at_the_command_line() -> None:
    """The guard runs before any database is opened."""
    args = _build_parser().parse_args(
        [SET_FIELD_COMMAND, "--stage", "2", "--field", PERSONA, "--value", " "]
    )
    with pytest.raises(StageCopyError, match="blank"):
        _select_operation(args)
