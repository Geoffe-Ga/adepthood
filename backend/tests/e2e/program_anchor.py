"""Move an e2e account's program anchor so the stage calendar has moved on.

Run it the way the frontend lane runs its launcher: from ``backend``, with
``PYTHONPATH=src`` and ``DATABASE_URL`` naming the lane's throwaway database::

    python -m tests.e2e.program_anchor anchor --email <EMAIL> --days-ago <N>
    python -m tests.e2e.program_anchor show --email <EMAIL>

Both subcommands write a single JSON object to stdout and exit 0.

Why this exists at all: advancing a stage is not an action a person takes. The
calendar laid over the 21x8 + 42x2 schedule decides which stage is on offer, and
*reading the Map* is what records that the person entered it -- see
``domain.stage_authority.record_stage_entry``, called from
``routers.stages._record_visit`` on ``GET /stages`` and
``GET /stages/program-calendar``.

``StageProgress.program_started_at`` can only ever be written as "now": the
model's ``default_factory`` on insert, and the begin-again reset in
``routers.stages``. No request schema accepts it. So no HTTP call can move the
anchor backwards, and a freshly registered e2e account is pinned at calendar
stage 1 for its first three weeks. A spec that signs up and then asserts
``current_stage == 1`` before and after would pass while proving nothing.

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


async def _show(session: AsyncSession, email: str) -> JsonObject:
    """Report the user's stage progress without writing anything.

    Raises:
        ProgramAnchorError: The user has no stage-progress row yet.
    """
    user_id = await _load_user_id(session, email)
    row = await get_user_progress(session, user_id)
    if row is None:
        msg = (
            f"{email!r} has no stage progress row to show; it is created on first "
            f"course access, or by the anchor subcommand"
        )
        raise ProgramAnchorError(msg)
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
    """Return the parser for the two subcommands the frontend lane invokes."""
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
    return parser


def _select_operation(args: argparse.Namespace) -> Operation:
    """Return the unit of work the parsed arguments ask for."""
    email = _normalize_email(str(args.email))
    if str(args.command) == ANCHOR_COMMAND:
        return partial(_anchor, email=email, days_ago=_require_days_ago(int(args.days_ago)))
    return partial(_show, email=email)


def main() -> None:
    """Run the requested subcommand and write its one JSON line to stdout."""
    payload = asyncio.run(_in_session(_select_operation(_build_parser().parse_args())))
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
