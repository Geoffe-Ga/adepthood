"""Read and rewrite stage copy in the frontend e2e lane's throwaway database.

Run it the way the frontend lane runs its other arrange module: from
``backend``, with ``PYTHONPATH=src`` and ``DATABASE_URL`` naming the lane's
throwaway database::

    python -m tests.e2e.stage_copy show
    python -m tests.e2e.stage_copy set-subtitle --stage <N> --subtitle <TEXT>

Both subcommands write a single JSON object to stdout and exit 0.

Why this exists: the stage copy a traveller reads -- a stage's title and the
two-word subtitle beneath it -- lives in the ``coursestage`` table, is served by
``GET /stages``, and is rendered verbatim by the Map's modal, its centre-cell
accessibility label, the magnifier caption and the Course cover. Nothing is
hardcoded client-side, which is correct, and which also means a spec that
asserts a literal on both ends of that seam proves only that the same two words
were typed twice: it would stay green if the route stopped reading the table
altogether. Binding the two ends needs the database's own answer, and no request
schema accepts one -- stage copy is seeded, never posted -- so the spec reads
and writes it here instead.

``show`` reports every stage's number, title and subtitle in stage order and
changes nothing. ``set-subtitle`` writes one stage's subtitle and reports the
row back. Neither touches any other column, and neither goes near the request
path: nothing is stubbed, mocked, patched or rebound, so the seam under test is
exactly the production one. The rows are addressed through the ``CourseStage``
model the router itself selects, so a column rename breaks this helper loudly
rather than silently arranging nothing.

Failure is loud everywhere. A missing ``DATABASE_URL``, a stage number no row
holds, or a blank subtitle each raise and exit non-zero, because an arrange step
that quietly does nothing leaves a spec asserting the state it started in.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from collections.abc import Awaitable, Callable
from functools import partial

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel import col, select

from database import normalize_database_url
from models import CourseStage

#: URL of the lane's throwaway database, the only one this module will touch.
DATABASE_URL_ENV = "DATABASE_URL"

#: Subcommand that reports every stage's copy and writes nothing.
SHOW_COMMAND = "show"

#: Subcommand that rewrites one stage's subtitle.
SET_SUBTITLE_COMMAND = "set-subtitle"

#: The JSON object each subcommand emits; values are ints, strings and lists.
JsonObject = dict[str, object]

#: A unit of work that runs inside a session this module opened and owns.
Operation = Callable[[AsyncSession], Awaitable[JsonObject]]


class StageCopyError(RuntimeError):
    """The stage copy cannot be read or rewritten as asked."""


def _require_env(name: str) -> str:
    """Return the value of ``name``, or raise naming what to set.

    Raises:
        StageCopyError: The variable is unset or blank.
    """
    value = os.environ.get(name, "").strip()
    if not value:
        msg = f"{name} is unset or blank; stage copy cannot be read without it"
        raise StageCopyError(msg)
    return value


def _require_subtitle(subtitle: str) -> str:
    """Return ``subtitle`` unchanged, refusing to write an empty one.

    A blank subtitle would make the spec's assertion vacuous: every render site
    interpolates the string as it stands, so an empty one is indistinguishable
    from a render site that dropped the field.

    Raises:
        StageCopyError: The subtitle is blank or whitespace only.
    """
    if not subtitle.strip():
        msg = "--subtitle must not be blank; an empty subtitle asserts nothing"
        raise StageCopyError(msg)
    return subtitle


def _serialize(row: CourseStage) -> JsonObject:
    """Return the copy fields the frontend spec reads, as JSON-safe values."""
    return {
        "stage_number": row.stage_number,
        "title": row.title,
        "subtitle": row.subtitle,
    }


async def _load_stage(session: AsyncSession, stage_number: int) -> CourseStage:
    """Return the ``coursestage`` row for ``stage_number``.

    Raises:
        StageCopyError: No stage carries that number.
    """
    result = await session.execute(
        select(CourseStage).where(CourseStage.stage_number == stage_number),
    )
    row = result.scalars().first()
    if row is None:
        msg = (
            f"no course stage is numbered {stage_number}; the lane's seeders run at "
            f"server startup, so check the server booted before arranging against it"
        )
        raise StageCopyError(msg)
    return row


async def _show(session: AsyncSession) -> JsonObject:
    """Report every stage's copy in stage order, writing nothing.

    Raises:
        StageCopyError: The table holds no stages at all.
    """
    query = select(CourseStage).order_by(col(CourseStage.stage_number).asc())
    result = await session.execute(query)
    rows = list(result.scalars().all())
    if not rows:
        msg = "the coursestage table is empty; the startup seeders did not run"
        raise StageCopyError(msg)
    return {"stages": [_serialize(row) for row in rows]}


async def _set_subtitle(session: AsyncSession, stage_number: int, subtitle: str) -> JsonObject:
    """Write ``subtitle`` onto one stage and report the row back.

    Only that one column is assigned: the spec asserts that the string a reader
    sees followed the table, so nothing else about the stage may move with it.
    """
    row = await _load_stage(session, stage_number)
    row.subtitle = subtitle
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
    """Return the parser for the two subcommands the frontend lane invokes."""
    parser = argparse.ArgumentParser(
        description="Read and rewrite stage copy for the frontend e2e lane.",
    )
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser(SHOW_COMMAND, help="report every stage's copy, changing nothing")
    write = subcommands.add_parser(SET_SUBTITLE_COMMAND, help="rewrite one stage's subtitle")
    write.add_argument("--stage", required=True, type=int, help="the stage number to rewrite")
    write.add_argument("--subtitle", required=True, help="the subtitle to store on that stage")
    return parser


def _select_operation(args: argparse.Namespace) -> Operation:
    """Return the unit of work the parsed arguments ask for."""
    if str(args.command) == SET_SUBTITLE_COMMAND:
        return partial(
            _set_subtitle,
            stage_number=int(args.stage),
            subtitle=_require_subtitle(str(args.subtitle)),
        )
    return _show


def main() -> None:
    """Run the requested subcommand and write its one JSON line to stdout."""
    payload = asyncio.run(_in_session(_select_operation(_build_parser().parse_args())))
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
