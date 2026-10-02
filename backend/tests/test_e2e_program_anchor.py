"""The e2e lane's program-anchor arrange forgets one past cycle's anchor, or fails loudly."""

from __future__ import annotations

from functools import partial

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from domain.stage_progress import ensure_user_progress, get_user_progress
from models import StageProgress
from tests.e2e.program_anchor import (
    FORGET_PAST_ANCHOR_COMMAND,
    ProgramAnchorError,
    _build_parser,
    _select_operation,
    _serialize,
    forget_past_anchor,
)
from tests.helpers.feedback_triage import make_account

EMAIL = "e2e-loop@example.com"
FIRST_ANCHOR = "2025-01-01T00:00:00+00:00"
SECOND_ANCHOR = "2025-09-10T00:00:00+00:00"
THIRD_CYCLE = 3
FINAL_STAGE = 10


async def _looped_row(
    session: AsyncSession, anchors: list[str | None], cycle_number: int = THIRD_CYCLE
) -> StageProgress:
    """A progress row for a fresh account that has looped to ``cycle_number``."""
    account = await make_account(session, EMAIL)
    row = await ensure_user_progress(session, account.user_id)
    row.cycle_number = cycle_number
    row.current_stage = FINAL_STAGE
    row.past_cycle_anchors = anchors
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


@pytest.mark.asyncio
async def test_forget_past_anchor_nulls_only_the_named_cycle_and_persists_the_rebind(
    db_session: AsyncSession,
) -> None:
    """Cycle 1's anchor becomes unknown; cycle 2's and every other column are untouched."""
    row = await _looped_row(db_session, [FIRST_ANCHOR, SECOND_ANCHOR])
    user_id = row.user_id
    program_started_at = row.program_started_at
    completed_stages = list(row.completed_stages)

    payload = await forget_past_anchor(db_session, f"  {EMAIL.upper()} ", 1)

    assert payload["past_cycle_anchors"] == [None, SECOND_ANCHOR]
    db_session.expire_all()
    stored = await get_user_progress(db_session, user_id)
    assert stored is not None
    assert stored.past_cycle_anchors == [None, SECOND_ANCHOR]
    assert stored.cycle_number == THIRD_CYCLE
    assert stored.current_stage == FINAL_STAGE
    assert list(stored.completed_stages) == completed_stages
    assert stored.program_started_at == program_started_at


@pytest.mark.asyncio
async def test_forget_past_anchor_pads_a_short_pre_2894_list(db_session: AsyncSession) -> None:
    """A list short of one element per past cycle is padded the way begin-again pads it."""
    row = await _looped_row(db_session, [SECOND_ANCHOR])
    user_id = row.user_id

    payload = await forget_past_anchor(db_session, EMAIL, 2)

    assert payload["past_cycle_anchors"] == [None, None]
    db_session.expire_all()
    stored = await get_user_progress(db_session, user_id)
    assert stored is not None
    assert stored.past_cycle_anchors == [None, None]


@pytest.mark.asyncio
async def test_forget_past_anchor_refuses_an_address_nobody_holds(
    db_session: AsyncSession,
) -> None:
    """An arrange that forgot nothing must not pass as one that worked."""
    with pytest.raises(ProgramAnchorError, match="no user is registered"):
        await forget_past_anchor(db_session, "nobody@example.com", 1)


@pytest.mark.asyncio
async def test_forget_past_anchor_refuses_an_account_with_no_progress_and_creates_none(
    db_session: AsyncSession,
) -> None:
    """No row is an error, never a reason to provision one."""
    account = await make_account(db_session, EMAIL)

    with pytest.raises(ProgramAnchorError, match="no stage progress row"):
        await forget_past_anchor(db_session, EMAIL, 1)
    assert await get_user_progress(db_session, account.user_id) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("cycle", [THIRD_CYCLE, THIRD_CYCLE + 1])
async def test_forget_past_anchor_refuses_the_live_or_an_unreached_cycle(
    db_session: AsyncSession, cycle: int
) -> None:
    """The current cycle's anchor is live, not retained, and a later one does not exist."""
    await _looped_row(db_session, [FIRST_ANCHOR, SECOND_ANCHOR])

    with pytest.raises(ProgramAnchorError, match=f"cycle {cycle} is not a past cycle"):
        await forget_past_anchor(db_session, EMAIL, cycle)


@pytest.mark.asyncio
async def test_forget_past_anchor_refuses_a_cycle_below_the_first(
    db_session: AsyncSession,
) -> None:
    """Cycle 0 names nothing, so it cannot index the list from the end."""
    await _looped_row(db_session, [FIRST_ANCHOR, SECOND_ANCHOR])

    with pytest.raises(ProgramAnchorError, match="--cycle must be 1 or more"):
        await forget_past_anchor(db_session, EMAIL, 0)


@pytest.mark.asyncio
async def test_forget_past_anchor_refuses_an_anchor_already_forgotten(
    db_session: AsyncSession,
) -> None:
    """Nulling a null changes nothing, and a no-op arrange is a failure."""
    await _looped_row(db_session, [None, SECOND_ANCHOR])

    with pytest.raises(ProgramAnchorError, match="already not on record"):
        await forget_past_anchor(db_session, EMAIL, 1)


@pytest.mark.asyncio
async def test_serialize_reports_no_past_anchors_as_an_empty_list(
    db_session: AsyncSession,
) -> None:
    """A row that never looped serialises an empty list, never null."""
    account = await make_account(db_session, EMAIL)
    row = await ensure_user_progress(db_session, account.user_id)

    assert _serialize(row)["past_cycle_anchors"] == []


def test_the_forget_subcommand_requires_a_cycle() -> None:
    """Argparse refuses the subcommand without --cycle rather than defaulting one."""
    with pytest.raises(SystemExit):
        _build_parser().parse_args([FORGET_PAST_ANCHOR_COMMAND, "--email", EMAIL])


def test_the_forget_subcommand_parses_its_cycle() -> None:
    """The cycle arrives as an int the operation can index with."""
    args = _build_parser().parse_args(
        [FORGET_PAST_ANCHOR_COMMAND, "--email", EMAIL, "--cycle", "1"]
    )

    assert args.cycle == 1


def test_the_forget_subcommand_selects_the_forget_operation() -> None:
    """The parsed subcommand runs forget, for the normalised address and the named cycle."""
    args = _build_parser().parse_args(
        [FORGET_PAST_ANCHOR_COMMAND, "--email", f" {EMAIL.upper()}", "--cycle", "2"]
    )

    operation = _select_operation(args)

    assert isinstance(operation, partial)
    assert operation.func is forget_past_anchor
    assert operation.keywords == {"email": EMAIL, "cycle": 2}
