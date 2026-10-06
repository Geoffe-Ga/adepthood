"""Audit, and finish, encryption at rest for every ``EncryptedString`` column.

Prepending a new key to ``JOURNAL_ENCRYPTION_KEYS`` re-encrypts a column only
when a write happens to modify it: SQLAlchemy flushes changed attributes alone.
Every untouched value keeps the token of the key it was written under, and a
row written before any key existed stays plaintext. So rotation never finishes
by itself, and a retired key can never safely be dropped. This command is what
finishes it.

``audit`` reads every encrypted column without decrypting it into output and
prints, per ``table.column``, how many values are NULL, plaintext, decryptable
by each configured key position (``key0`` is the primary), and decryptable by
none. It prints counts and names only -- never a value, a length, a hash, a row
owner, or a key.

``reencrypt`` rewrites every plaintext and non-primary value under the primary
key. It is a dry run unless ``--apply`` is given. It pages each column by ``id``
(keyset, ``--batch-size`` rows at a time), commits per batch, and prints the
last committed id so ``--start-after table.column:ID`` can resume an interrupted
run (a plain rerun is also safe: rows already on the primary key are skipped).
Each write is compare-and-swap -- ``UPDATE ... WHERE id = :id AND col = :old``
-- so a value a user rewrote meanwhile is skipped, not clobbered. A value no
configured key decrypts stops the run *before* anything in its batch is
written; plaintext is never written.

The columns come from ``services.encryption_inventory``, derived from the
schema, so a column added later is covered without editing this file.

Usage, from ``backend/`` with ``DATABASE_URL`` and ``JOURNAL_ENCRYPTION_KEYS``
set exactly as the service has them::

    PYTHONPATH=src python -m scripts.journal_encryption_sweep audit
    PYTHONPATH=src python -m scripts.journal_encryption_sweep reencrypt
    PYTHONPATH=src python -m scripts.journal_encryption_sweep reencrypt --apply

Exit codes:
    0 -- clean: no plaintext, every token on the primary key (``audit``), or
         the sweep completed with nothing left behind (``reencrypt``).
    1 -- rows remain: plaintext or old-key values exist (``audit`` or a dry
         run), or an applied sweep skipped rows a user rewrote meanwhile.
    2 -- usage error (argparse).
    3 -- integrity stop: no key configured, a malformed key, or a value no
         configured key decrypts. Nothing in the failing batch was written.
    4 -- database stop: the database failed mid-run (timeout, deadlock, lost
         connection). Reported by error class, column and resume point only;
         the batch in flight was rolled back.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import cast

from sqlalchemy import CursorResult, and_, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.sql.expression import TableClause

from database import DATABASE_URL
from services import journal_encryption as je
from services.encryption_inventory import (
    ROW_ID_COLUMN,
    EncryptedColumn,
    encrypted_columns,
    raw_table,
)

EXIT_CLEAN = 0
EXIT_ROWS_REMAIN = 1
#: argparse's own code for a malformed command line.
EXIT_USAGE = 2
#: Distinct from argparse's 2: "you typed it wrong" and "the data or keys are
#: not what they must be" call for different responses.
EXIT_INTEGRITY = 3
#: The database failed under the sweep (lock or statement timeout, deadlock,
#: dropped connection). The batch in flight was rolled back; rerun or resume.
EXIT_DATABASE = 4

#: Rows read, planned, written and committed together. Small enough that a
#: batch's row locks are brief beside live traffic; large enough that a big
#: table is not one round-trip per row.
DEFAULT_BATCH_SIZE = 500

_CURSOR_SEPARATOR = ":"

# The sweep's own engine, with bind parameters hidden from every error it can
# raise: the compare-and-swap's ``old`` parameter is the stored value, which for
# a legacy row is the user's plaintext. ``run`` also catches database errors and
# reports them by class name only; this keeps an uncaught one content-free too.
engine = create_async_engine(DATABASE_URL, echo=False, hide_parameters=True)
async_session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

Row = tuple[int, str | None]
Rewrite = tuple[int, str, str]


class SweepIntegrityError(RuntimeError):
    """A value no configured key decrypts; its batch was not written."""


class SweepDatabaseError(RuntimeError):
    """The database failed mid-sweep; named by class and column, never by value."""


@dataclass
class ColumnAudit:
    """Counts for one column. Names and integers only, by construction."""

    target: EncryptedColumn
    key_count: int
    null: int = 0
    plaintext: int = 0
    undecryptable: int = 0
    by_key: list[int] = field(default_factory=list)

    def __post_init__(self) -> None:
        """Start one counter per configured key position."""
        self.by_key = [0] * self.key_count

    def tally(self, value: str | None) -> None:
        """Count one stored value by kind."""
        if value is None:
            self.null += 1
        elif not je.is_ciphertext(value):
            self.plaintext += 1
        else:
            index = je.key_index(value)
            if index is None:
                self.undecryptable += 1
            else:
                self.by_key[index] += 1

    @property
    def needs_sweep(self) -> bool:
        """Plaintext or a token that still needs a non-primary key."""
        return self.plaintext > 0 or sum(self.by_key[1:]) > 0

    def render(self) -> str:
        """One ``audit table.column k=v ...`` line."""
        keys = " ".join(f"key{index}={count}" for index, count in enumerate(self.by_key))
        return (
            f"audit {self.target.qualified} null={self.null} plaintext={self.plaintext} "
            f"{keys} undecryptable={self.undecryptable}"
        )


@dataclass
class ColumnSweep:
    """What a sweep did (or, dry, would do) to one column."""

    target: EncryptedColumn
    apply: bool
    encrypted: int = 0
    rotated: int = 0
    already_primary: int = 0
    skipped: int = 0
    last_id: int = 0

    @property
    def left_behind(self) -> bool:
        """Rows still needing the sweep: all of them dry, the skipped ones applied."""
        if self.apply:
            return self.skipped > 0
        return self.encrypted + self.rotated > 0

    def render(self) -> str:
        """One ``reencrypt table.column k=v ...`` line."""
        mode = "apply" if self.apply else "dry-run"
        return (
            f"reencrypt {self.target.qualified} mode={mode} encrypted={self.encrypted} "
            f"rotated={self.rotated} already_primary={self.already_primary} "
            f"skipped={self.skipped} last_id={self.last_id}"
        )


@dataclass(frozen=True)
class StartAfter:
    """Resume point: begin at ``target`` after row ``row_id``."""

    target: EncryptedColumn
    row_id: int


def _say(line: str) -> None:
    sys.stdout.write(line + "\n")


def _warn(line: str) -> None:
    sys.stderr.write(line + "\n")


async def _batch(
    session: AsyncSession, target: EncryptedColumn, after: int, size: int
) -> list[Row]:
    """The next ``size`` rows of ``target`` with id greater than ``after``."""
    raw = raw_table(target)
    row_id = raw.c[ROW_ID_COLUMN]
    result = await session.execute(
        select(row_id, raw.c[target.column]).where(row_id > after).order_by(row_id).limit(size)
    )
    return [(int(found_id), value) for found_id, value in result.all()]


async def audit_column(
    session: AsyncSession, target: EncryptedColumn, batch_size: int
) -> ColumnAudit:
    """Count every stored value of ``target`` by kind."""
    report = ColumnAudit(target, key_count=je.key_count())
    after = 0
    while rows := await _batch(session, target, after, batch_size):
        for _, value in rows:
            report.tally(value)
        after = rows[-1][0]
    return report


def _needs_rewrite(target: EncryptedColumn, row_id: int, value: str, report: ColumnSweep) -> bool:
    """Count one stored value's fate; raise if no configured key decrypts it."""
    if not je.is_ciphertext(value):
        report.encrypted += 1
        return True
    index = je.key_index(value)
    if index is None:
        msg = (
            f"{target.qualified} row {row_id} does not decrypt under any configured "
            "key; nothing in its batch was written"
        )
        raise SweepIntegrityError(msg)
    if index == 0:
        report.already_primary += 1
        return False
    report.rotated += 1
    return True


def _plan(target: EncryptedColumn, rows: list[Row], report: ColumnSweep) -> list[Rewrite]:
    """Decide every row's fate before any write; raise on an undecryptable one.

    Dry, the counts are the whole result. Applied, each rewrite carries the
    value it was read with, for the compare-and-swap.
    """
    rewrites: list[Rewrite] = []
    for row_id, value in rows:
        if value is not None and _needs_rewrite(target, row_id, value, report):
            rewrites.append((row_id, value, je.rotate(value) if report.apply else value))
    return rewrites


async def apply_rewrites(
    session: AsyncSession, target: EncryptedColumn, rewrites: Sequence[Rewrite]
) -> int:
    """Compare-and-swap each rewrite and commit; returns how many rows changed."""
    raw: TableClause = raw_table(target)
    stored = raw.c[target.column]
    written = 0
    for row_id, old, new in rewrites:
        # ``execute`` is typed ``Result``; an UPDATE yields a ``CursorResult``
        # whose ``rowcount`` says whether the compare-and-swap matched.
        result = cast(
            "CursorResult[tuple[()]]",
            await session.execute(
                update(raw)
                .where(and_(raw.c[ROW_ID_COLUMN] == row_id, stored == old))
                .values({target.column: new})
            ),
        )
        written += int(result.rowcount)
    await session.commit()
    return written


async def reencrypt_column(
    session: AsyncSession,
    target: EncryptedColumn,
    *,
    apply: bool,
    batch_size: int,
    after: int = 0,
) -> ColumnSweep:
    """Move every plaintext and old-key value of ``target`` to the primary key."""
    report = ColumnSweep(target, apply=apply, last_id=after)
    try:
        while rows := await _batch(session, target, report.last_id, batch_size):
            await _sweep_batch(session, target, rows, report)
            report.last_id = rows[-1][0]
    except SQLAlchemyError as exc:
        await stop_batch(session, report)
        # ``from None``: the original carries the bind parameters in its str.
        msg = f"{type(exc).__name__} while sweeping {target.qualified}"
        raise SweepDatabaseError(msg) from None
    except (SweepIntegrityError, je.JournalEncryptionError):
        await stop_batch(session, report)
        raise
    return report


async def _sweep_batch(
    session: AsyncSession, target: EncryptedColumn, rows: list[Row], report: ColumnSweep
) -> None:
    """Plan one batch in full, then (applied) write and commit it."""
    rewrites = _plan(target, rows, report)
    if report.apply:
        report.skipped += len(rewrites) - await apply_rewrites(session, target, rewrites)
        _warn(f"committed {target.qualified} through id={rows[-1][0]}")


async def stop_batch(session: AsyncSession, report: ColumnSweep) -> None:
    """Roll back the batch in flight and say where to resume."""
    try:
        await session.rollback()
    except SQLAlchemyError:
        _warn("rollback failed; the connection is gone and its transaction with it")
    resume = f"{report.target.qualified}{_CURSOR_SEPARATOR}{report.last_id}"
    _warn(f"stopped at {report.target.qualified}: resume with --start-after {resume}")


def _columns_from(start: StartAfter | None) -> list[tuple[EncryptedColumn, int]]:
    """Columns to visit, each with the id to start after."""
    if start is None:
        return [(target, 0) for target in encrypted_columns()]
    later = [(target, 0) for target in encrypted_columns() if target > start.target]
    return [(start.target, start.row_id), *later]


async def _audit(batch_size: int) -> int:
    reports: list[ColumnAudit] = []
    async with async_session_factory() as session:
        for target in encrypted_columns():
            report = await audit_column(session, target, batch_size)
            _say(report.render())
            reports.append(report)
    return _audit_exit_code(reports)


def _audit_exit_code(reports: Sequence[ColumnAudit]) -> int:
    """Integrity first: an unreadable value outranks one merely not yet swept."""
    if any(report.undecryptable for report in reports):
        return EXIT_INTEGRITY
    if any(report.needs_sweep for report in reports):
        return EXIT_ROWS_REMAIN
    return EXIT_CLEAN


async def _reencrypt(*, apply: bool, batch_size: int, start: StartAfter | None) -> int:
    reports = []
    async with async_session_factory() as session:
        for target, after in _columns_from(start):
            report = await reencrypt_column(
                session, target, apply=apply, batch_size=batch_size, after=after
            )
            _say(report.render())
            reports.append(report)
    return EXIT_ROWS_REMAIN if any(report.left_behind for report in reports) else EXIT_CLEAN


def _start_after(value: str) -> StartAfter:
    """Parse ``table.column:ID`` against the live inventory."""
    qualified, separator, row_id = value.rpartition(_CURSOR_SEPARATOR)
    known = {target.qualified: target for target in encrypted_columns()}
    if not separator or qualified not in known or not row_id.isdigit():
        msg = f"expected TABLE.COLUMN:ID naming an encrypted column, one of: {', '.join(known)}"
        raise argparse.ArgumentTypeError(msg)
    return StartAfter(known[qualified], int(row_id))


def _positive(value: str) -> int:
    if not value.isdigit() or int(value) < 1:
        msg = "must be a positive integer"
        raise argparse.ArgumentTypeError(msg)
    return int(value)


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    """Parse the command line; a malformed one exits with :data:`EXIT_USAGE`."""
    parser = argparse.ArgumentParser(
        prog="python -m scripts.journal_encryption_sweep",
        description="Audit or finish encryption at rest. Prints counts and names only.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    audit = commands.add_parser("audit", help="count values per column by kind")
    audit.add_argument("--batch-size", type=_positive, default=DEFAULT_BATCH_SIZE)
    sweep = commands.add_parser("reencrypt", help="move every value to the primary key")
    sweep.add_argument("--apply", action="store_true", help="write (default: dry run)")
    sweep.add_argument("--batch-size", type=_positive, default=DEFAULT_BATCH_SIZE)
    sweep.add_argument("--start-after", type=_start_after, default=None, metavar="TABLE.COLUMN:ID")
    return parser.parse_args(argv)


async def _dispatch(args: argparse.Namespace) -> int:
    """Refuse without keys, then run the chosen command."""
    if je.key_count() == 0:
        _warn(f"{je.KEYS_ENV_VAR} is not configured; nothing can be verified or encrypted")
        return EXIT_INTEGRITY
    if args.command == "audit":
        return await _audit(args.batch_size)
    return await _reencrypt(apply=args.apply, batch_size=args.batch_size, start=args.start_after)


async def run(argv: Sequence[str] | None = None) -> int:
    """Run one command and return its exit code.

    The keys are checked before any session is opened: with none configured
    there is nothing to verify against and nothing to encrypt with.
    """
    args = parse_args(argv)
    try:
        return await _dispatch(args)
    except (SweepIntegrityError, je.JournalEncryptionError) as exc:
        _warn(f"integrity stop: {exc}")
        return EXIT_INTEGRITY
    except SweepDatabaseError as exc:
        _warn(f"database stop: {exc}")
        return EXIT_DATABASE
    except SQLAlchemyError as exc:
        # Class name only: the message can carry bind parameters.
        _warn(f"database stop: {type(exc).__name__}")
        return EXIT_DATABASE


def main(argv: Sequence[str] | None = None) -> int:
    """Synchronous entry point.

    Args:
        argv: Arguments without the program name, or ``None`` for ``sys.argv``.

    Returns:
        The process exit code.
    """
    return asyncio.run(run(argv))


if __name__ == "__main__":  # pragma: no cover — exercised via tests/CLI
    sys.exit(main(sys.argv[1:]))
