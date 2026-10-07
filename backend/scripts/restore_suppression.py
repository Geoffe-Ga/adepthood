r"""Export deletion tombstones before a restore, and reapply them after (#3063).

The operator half of :mod:`services.restore_suppression`. See DEPLOYMENT.md
"Restoring, step by step" for where each command runs in the procedure.

Usage, from ``backend/`` with ``DATABASE_URL`` pointing at the database::

    # Against the LIVE database, before restoring anything:
    PYTHONPATH=src python -m scripts.restore_suppression export --out tombstones.json

    # Against the RESTORED database, before cutover:
    PYTHONPATH=src python -m scripts.restore_suppression reapply \
        --in tombstones.json --restore-id 2026-10-07-staging

The tombstone file is content-free (ids and instants only) but it is still a
list of who deleted what and when, so ``export`` writes it owner-only and never
overwrites an existing file. Where it is kept is undecided (#3063 AC17).

Exit codes:
    0 -- done.
    1 -- refused: a registry gap, an already-complete restore, an existing
         output file, or a database error (reported by class name only).
    2 -- the input file is missing or is not a tombstone set; or a usage error.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Final

from sqlalchemy.exc import SQLAlchemyError

from database import async_session_factory
from services.account_deletion import ErasurePolicyGapError
from services.restore_suppression import (
    MalformedTombstoneError,
    RestoreAlreadyCompleteError,
    RetentionGapError,
    TombstoneSet,
    export_tombstones,
    reapply_tombstones,
)

EXIT_OK: Final = 0
EXIT_REFUSED: Final = 1
EXIT_MALFORMED: Final = 2

# Owner read/write only: the file names accounts that asked to be forgotten.
_OWNER_ONLY: Final = 0o600
_REFUSALS = (
    ErasurePolicyGapError,
    RetentionGapError,
    RestoreAlreadyCompleteError,
    FileExistsError,
)


def _warn(message: str) -> None:
    sys.stderr.write(f"{message}\n")


def _say(message: str) -> None:
    sys.stdout.write(f"{message}\n")


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    """Parse the two subcommands; argparse exits 2 on a usage error."""
    parser = argparse.ArgumentParser(prog="restore_suppression", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("export", help="write the live database's tombstones")
    export.add_argument("--out", required=True, type=Path)
    reapply = commands.add_parser("reapply", help="apply tombstones to a restored database")
    reapply.add_argument("--in", dest="source", required=True, type=Path)
    reapply.add_argument("--restore-id", required=True)
    return parser.parse_args(argv)


async def _export(out: Path) -> int:
    async with async_session_factory() as session:
        tombstones = await export_tombstones(session)
    payload = json.dumps(tombstones.to_json(), indent=2)
    descriptor = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, _OWNER_ONLY)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(payload)
    _say(f"exported accounts={len(tombstones.accounts)} entries={len(tombstones.entries)}")
    return EXIT_OK


def _load(source: Path) -> TombstoneSet:
    try:
        document = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        msg = f"cannot read a tombstone set from {source}: {type(exc).__name__}"
        raise MalformedTombstoneError(msg) from exc
    return TombstoneSet.from_json(document)


async def _reapply(source: Path, restore_id: str) -> int:
    tombstones = _load(source)
    receipt = await reapply_tombstones(async_session_factory, tombstones, restore_id=restore_id)
    _say(
        f"reapplied restore_id={receipt.restore_id} "
        f"accounts_reapplied={receipt.accounts_reapplied} "
        f"accounts_absent={receipt.accounts_absent} "
        f"entries_reapplied={receipt.entries_reapplied} "
        f"entries_absent={receipt.entries_absent} "
        f"identity_mismatches={receipt.identity_mismatches}"
    )
    return EXIT_OK


async def run(argv: Sequence[str] | None = None) -> int:
    """Run one command and return its exit code."""
    args = parse_args(argv)
    try:
        if args.command == "export":
            return await _export(args.out)
        return await _reapply(args.source, args.restore_id)
    except MalformedTombstoneError as exc:
        _warn(f"malformed: {exc}")
        return EXIT_MALFORMED
    except _REFUSALS as exc:
        _warn(f"refused: {type(exc).__name__}: {exc}")
        return EXIT_REFUSED
    except SQLAlchemyError as exc:
        # Class name only: a driver message can carry bind parameters.
        _warn(f"database stop: {type(exc).__name__}")
        return EXIT_REFUSED


def main(argv: Sequence[str] | None = None) -> int:
    """Synchronous entry point."""
    return asyncio.run(run(argv))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
