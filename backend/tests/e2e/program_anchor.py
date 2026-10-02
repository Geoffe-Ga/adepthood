"""Move an e2e account's program anchor so the stage calendar has moved on.

Run it the way the frontend lane runs its launcher: from ``backend``, with
``PYTHONPATH=src`` and ``DATABASE_URL`` naming the lane's throwaway database::

    python -m tests.e2e.program_anchor anchor --email <EMAIL> --days-ago <N>
    python -m tests.e2e.program_anchor show --email <EMAIL>
    python -m tests.e2e.program_anchor forget-past-anchor --email <EMAIL> --cycle <K>

Each subcommand writes a single JSON object to stdout and exits 0.

Why this exists at all: advancing a stage is not an action a person takes. The
calendar laid over the 21x8 + 42x2 schedule decides which stage is on offer, and
*reading the Map* is what records that the person entered it -- see
``domain.stage_authority.record_stage_entry``, called from
``routers.stages._record_visit`` on ``GET /stages`` and
``GET /stages/program-calendar``.

``StageProgress.program_started_at`` can only ever be written as "now": the
model's ``default_factory`` on insert, and the begin-again reset in
``routers.stages`` (which also retains the displaced value on
``past_cycle_anchors``, issue #2894 -- a record of a PAST cycle, never a way to
move the current anchor). No request schema accepts either field. So no HTTP
call can move the anchor backwards, and a freshly registered e2e account is
pinned at calendar stage 1 for its first three weeks. A spec that signs up and
then asserts ``current_stage == 1`` before and after would pass while proving
nothing.

This module is therefore the *arrange* for that journey and nothing else. It
moves the anchor directly in the lane's own throwaway Postgres so that the
calendar has genuinely moved, and the spec then reads back through the unmocked
production client and asserts that the record advanced. It stubs, mocks, patches
and rebinds nothing -- the request path is untouched, which is precisely what
keeps the lane's guarantee intact. The next reader will reasonably ask what got
faked, so, stated plainly: the only thing faked is the passage of time, and it is
faked in the database rather than anywhere on the path under test. The row is
provisioned by the same ``ensure_user_progress`` the course router calls, so a
model rename breaks this helper loudly instead of silently arranging nothing.

``anchor`` moves ``program_started_at`` and ``stage_started_at`` and nothing
else. ``current_stage``, ``completed_stages``, ``highest_stage_reached`` and
``cycle_number`` are left exactly as found, because moving the calendar must not
move the record: that the record catches up on the next read is the assertion the
spec is there to make.

``forget-past-anchor`` writes one column, ``past_cycle_anchors``, and nothing
else: it nulls cycle ``K``'s retained program start. Begin-again has recorded
that anchor since issue #2894, so a loop made before then -- whose anchor was
destroyed and cannot be rebuilt -- is no longer reachable over HTTP; this is
the arrange that stands one up, so the reflection feed's "unrecorded" period
can be driven end to end. It pads a short list with ``None`` exactly as
``routers.stages._padded_anchors`` does and REBINDS the column (an in-place
mutation of a JSON column is silently dropped on commit). It refuses an
account with no progress row (it never creates one), a cycle below 1, the live
cycle or any later one, and an anchor already not on record, because nulling a
null is an arrange that changed nothing.

Failure is loud everywhere. A missing ``DATABASE_URL``, an email no user holds, a
``show`` for a user with no progress row, or a negative ``--days-ago`` each raise
and exit non-zero. There is no fallback and no silent success: an arrange step
that quietly does nothing leaves a spec asserting the state it started in, which
is the defect this whole exercise exists to remove.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from functools import partial

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel import select

from database import normalize_database_url
from domain.stage_progress import ensure_user_progress, get_user_progress
from models import StageProgress, User

#: URL of the lane's throwaway database, the only one this module will touch.
DATABASE_URL_ENV = "DATABASE_URL"

#: Subcommand that moves the anchor back and reports the row afterwards.
ANCHOR_COMMAND = "anchor"

#: Subcommand that reports the row and changes nothing.
SHOW_COMMAND = "show"

#: Subcommand that nulls one past cycle's retained anchor, as a pre-#2894 loop left it.
FORGET_PAST_ANCHOR_COMMAND = "forget-past-anchor"

#: The lowest cycle number that names a real cycle.
FIRST_CYCLE = 1

#: The JSON object each subcommand emits; values are ints, lists and strings.
JsonObject = dict[str, object]

#: A unit of work that runs inside a session this module opened and owns.
Operation = Callable[[AsyncSession], Awaitable[JsonObject]]


class ProgramAnchorError(RuntimeError):
    """The arrange step cannot be carried out as asked."""


def _require_env(name: str) -> str:
    """Return the value of ``name``, or raise naming what to set.

    Raises:
        ProgramAnchorError: The variable is unset or blank.
    """
    value = os.environ.get(name, "").strip()
    if not value:
        msg = f"{name} is unset or blank; the program anchor cannot be moved without it"
        raise ProgramAnchorError(msg)
    return value


def _require_days_ago(days_ago: int) -> int:
    """Return ``days_ago`` unchanged, refusing to anchor into the future.

    Raises:
        ProgramAnchorError: ``days_ago`` is negative.
    """
    if days_ago < 0:
        msg = f"--days-ago must be zero or more; got {days_ago}"
        raise ProgramAnchorError(msg)
    return days_ago


def _normalize_email(email: str) -> str:
    """Return ``email`` in the form the signup boundary stores.

    ``routers.auth`` strips and lowercases every address before it reaches the
    database, so the lookup here has to do the same or an address the caller
    typed in mixed case would appear not to exist.
    """
    return email.strip().lower()


def _require_anchor(row: StageProgress) -> datetime:
    """Return the row's program anchor, refusing to report a null one.

    The column is nullable for rows predating the anchor, and every code path
    that creates a row now fills it. A null here means the row came from
    somewhere this helper does not understand, which is worth saying out loud
    rather than emitting ``null`` into a payload the spec will index into.

    Raises:
        ProgramAnchorError: The row has no ``program_started_at``.
    """
    anchor = row.program_started_at
    if anchor is None:
        msg = (
            f"stage progress for user {row.user_id} has no program_started_at; "
            f"run the anchor subcommand to set one"
        )
        raise ProgramAnchorError(msg)
    return anchor


def _serialize(row: StageProgress) -> JsonObject:
    """Return the fields the frontend spec reads, as JSON-safe values."""
    return {
        "user_id": row.user_id,
        "current_stage": row.current_stage,
        "completed_stages": list(row.completed_stages),
        "cycle_number": row.cycle_number,
        "highest_stage_reached": row.highest_stage_reached,
        "program_started_at": _require_anchor(row).isoformat(),
        "stage_started_at": row.stage_started_at.isoformat(),
        "past_cycle_anchors": list(row.past_cycle_anchors or []),
    }


async def _load_user_id(session: AsyncSession, email: str) -> int:
    """Return the id of the user registered under ``email``.

    Selects the key alone rather than the row: this helper has no use for a
    password hash, and an arrange step that never loads one cannot leak one into
    a traceback.

    Raises:
        ProgramAnchorError: No user holds that address.
    """
    result = await session.execute(select(User.id).where(User.email == email))
    user_id = result.scalars().first()
    if user_id is None:
        msg = f"no user is registered as {email!r}; sign the account up before anchoring it"
        raise ProgramAnchorError(msg)
    return int(user_id)


async def _anchor(session: AsyncSession, email: str, days_ago: int) -> JsonObject:
    """Move both start timestamps to ``days_ago`` days before now, and report the row.

    Only the two timestamps are assigned. The stage the record sits at is left
    untouched on purpose: the spec asserts that reading the Map is what moves it.
    """
    user_id = await _load_user_id(session, email)
    row = await ensure_user_progress(session, user_id)
    moved_to = datetime.now(UTC) - timedelta(days=days_ago)
    row.program_started_at = moved_to
    row.stage_started_at = moved_to
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _serialize(row)


async def _require_progress(session: AsyncSession, email: str) -> StageProgress:
    """Return the stage-progress row of the user registered under ``email``.

    Reads it and never provisions one: an arrange that created the row it was
    asked to inspect or edit would hide the very state it was pointed at.

    Raises:
        ProgramAnchorError: No user holds that address, or it has no row yet.
    """
    user_id = await _load_user_id(session, email)
    row = await get_user_progress(session, user_id)
    if row is None:
        msg = (
            f"{email!r} has no stage progress row; it is created on first "
            f"course access, or by the anchor subcommand"
        )
        raise ProgramAnchorError(msg)
    return row


async def _show(session: AsyncSession, email: str) -> JsonObject:
    """Report the user's stage progress without writing anything.

    Raises:
        ProgramAnchorError: The user has no stage-progress row yet.
    """
    return _serialize(await _require_progress(session, email))


def _padded_past_anchors(row: StageProgress) -> list[str | None]:
    """The row's retained anchors as a NEW list, left-padded to one per past cycle.

    Mirrors ``routers.stages._padded_anchors``: a list short of
    ``cycle_number - 1`` elements is missing its leading, unrecoverable cycles.
    """
    retained = list(row.past_cycle_anchors or [])
    missing = max(0, row.cycle_number - 1 - len(retained))
    return [None] * missing + retained


def _require_past_cycle(row: StageProgress, cycle: int) -> int:
    """Return the list index of past cycle ``cycle``, refusing one that is not past.

    Raises:
        ProgramAnchorError: ``cycle`` is below 1, or is the live cycle or later.
    """
    if cycle < FIRST_CYCLE:
        msg = f"--cycle must be {FIRST_CYCLE} or more; got {cycle}"
        raise ProgramAnchorError(msg)
    if cycle >= row.cycle_number:
        msg = (
            f"cycle {cycle} is not a past cycle: the account is living cycle "
            f"{row.cycle_number}, whose anchor is live rather than retained"
        )
        raise ProgramAnchorError(msg)
    return cycle - FIRST_CYCLE


async def forget_past_anchor(session: AsyncSession, email: str, cycle: int) -> JsonObject:
    """Null past cycle ``cycle``'s retained anchor, and report the row.

    Stands up the state a begin-again from before issue #2894 left behind: the
    cycle happened, but the instant it began is no longer on record. Only
    ``past_cycle_anchors`` is written, and it is rebound to a new list.

    Raises:
        ProgramAnchorError: No such user or row, ``cycle`` is not a past cycle,
            or its anchor is already not on record.
    """
    row = await _require_progress(session, _normalize_email(email))
    index = _require_past_cycle(row, cycle)
    anchors = _padded_past_anchors(row)
    if anchors[index] is None:
        msg = f"cycle {cycle}'s anchor is already not on record; nothing to forget"
        raise ProgramAnchorError(msg)
    anchors[index] = None
    row.past_cycle_anchors = anchors
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _serialize(row)


async def _in_session(operation: Operation) -> JsonObject:
    """Run ``operation`` against the lane's database, disposing the engine after."""
    engine = create_async_engine(
        normalize_database_url(_require_env(DATABASE_URL_ENV)),
        poolclass=NullPool,
    )
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            return await operation(session)
    finally:
        await engine.dispose()


def _build_parser() -> argparse.ArgumentParser:
    """Return the parser for the subcommands the frontend lane invokes."""
    parser = argparse.ArgumentParser(
        description="Arrange the program anchor for the frontend e2e lane.",
    )
    subcommands = parser.add_subparsers(dest="command", required=True)
    anchor = subcommands.add_parser(ANCHOR_COMMAND, help="move the anchor back N days")
    anchor.add_argument("--email", required=True, help="address the account signed up with")
    anchor.add_argument(
        "--days-ago",
        required=True,
        type=int,
        help="how many days before now to place both start timestamps",
    )
    show = subcommands.add_parser(SHOW_COMMAND, help="report the row, changing nothing")
    show.add_argument("--email", required=True, help="address the account signed up with")
    forget = subcommands.add_parser(
        FORGET_PAST_ANCHOR_COMMAND, help="null one past cycle's retained anchor"
    )
    forget.add_argument("--email", required=True, help="address the account signed up with")
    forget.add_argument(
        "--cycle",
        required=True,
        type=int,
        help="the past cycle whose anchor to forget (1 is the first)",
    )
    return parser


def _select_operation(args: argparse.Namespace) -> Operation:
    """Return the unit of work the parsed arguments ask for."""
    email = _normalize_email(str(args.email))
    if str(args.command) == ANCHOR_COMMAND:
        return partial(_anchor, email=email, days_ago=_require_days_ago(int(args.days_ago)))
    if str(args.command) == FORGET_PAST_ANCHOR_COMMAND:
        return partial(forget_past_anchor, email=email, cycle=int(args.cycle))
    return partial(_show, email=email)


def main() -> None:
    """Run the requested subcommand and write its one JSON line to stdout."""
    payload = asyncio.run(_in_session(_select_operation(_build_parser().parse_args())))
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
