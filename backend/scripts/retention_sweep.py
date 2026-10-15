"""Apply every ratified retention period, once; run nightly by a Railway cron service.

The owner ratified a lifetime for every table on 2026-10-13 (#3063 AC15) and
chose how they are applied on 2026-10-14 (#3266): one script, run every night
by a Railway cron service against the production database. This is that
script. What each store keeps and removes is :mod:`services.retention_sweep`;
the periods are the registry's (:mod:`domain.retention`), never restated here.

Every store is swept in its own transaction. A store that fails is rolled back,
logged by its error's class name only, and the run carries on with the next;
the process then exits non-zero so the cron run shows as failed.

Output, on stdout and as structured log records, is one line per store with
the store's name, the eligible count, the deleted count, the blocked count and
the duration -- nothing else. No id, email, IP, token or content is ever
printed, and a database error is reported by class, never by message (a
message can quote a bound value).

Usage, from ``backend/`` with ``DATABASE_URL`` set as the service has it (in
the image, ``/app`` is the working directory and ``PYTHONPATH`` is preset)::

    PYTHONPATH=src python -m scripts.retention_sweep --dry-run
    PYTHONPATH=src python -m scripts.retention_sweep

``RESTORE_ID``, when set as the backend has it, keeps the restore marker the
startup gate names. No sweep decrypts anything, so ``JOURNAL_ENCRYPTION_KEYS``
is not needed.

Exit codes:
    0 -- every store swept (or counted, on ``--dry-run``).
    1 -- at least one store failed; the others still ran.
    2 -- usage error (argparse).
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from database import DATABASE_URL
from observability import configure_logging
from services.retention_sweep import SWEEPS, StoreOutcome, StoreSweep, run_sweeps

EXIT_CLEAN: Final = 0
EXIT_STORE_FAILED: Final = 1

_EVENT: Final = "retention_sweep_store"
_FAILED_EVENT: Final = "retention_sweep_store_failed"
_DONE_EVENT: Final = "retention_sweep_done"

logger = logging.getLogger("retention_sweep")

# Bind parameters are hidden from every error the engine raises, so nothing a
# row holds can reach a log line through an exception.
engine = create_async_engine(DATABASE_URL, echo=False, hide_parameters=True)
async_session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


def _parse(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m scripts.retention_sweep",
        description="Apply every ratified retention period (#3266).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="count what each store would remove, and change nothing",
    )
    return parser.parse_args(argv)


def _mode(*, dry_run: bool) -> str:
    return "dry-run" if dry_run else "apply"


def _report(outcome: StoreOutcome, mode: str) -> None:
    """One store's line on stdout and in the log: names and integers only."""
    if outcome.counts is None:
        logger.error(
            _FAILED_EVENT,
            extra={
                "store": outcome.store,
                "mode": mode,
                "error": outcome.error,
                "duration_ms": outcome.duration_ms,
            },
        )
        sys.stdout.write(
            f"{_FAILED_EVENT} store={outcome.store} mode={mode} error={outcome.error} "
            f"duration_ms={outcome.duration_ms}\n"
        )
        return
    counts = outcome.counts
    logger.info(
        _EVENT,
        extra={
            "store": outcome.store,
            "mode": mode,
            "eligible": counts.eligible,
            "deleted": counts.deleted,
            "blocked": counts.blocked,
            "duration_ms": outcome.duration_ms,
        },
    )
    sys.stdout.write(
        f"{_EVENT} store={outcome.store} mode={mode} eligible={counts.eligible} "
        f"deleted={counts.deleted} blocked={counts.blocked} "
        f"duration_ms={outcome.duration_ms}\n"
    )


async def run(argv: Sequence[str] | None = None, *, sweeps: Sequence[StoreSweep] = SWEEPS) -> int:
    """Sweep every store once and report it; non-zero when any store failed."""
    args = _parse(argv)
    mode = _mode(dry_run=args.dry_run)
    outcomes = await run_sweeps(
        async_session_factory, now=datetime.now(UTC), dry_run=args.dry_run, sweeps=sweeps
    )
    for outcome in outcomes:
        _report(outcome, mode)
    failed = sum(outcome.counts is None for outcome in outcomes)
    logger.info(_DONE_EVENT, extra={"mode": mode, "stores": len(outcomes), "failed": failed})
    sys.stdout.write(f"{_DONE_EVENT} mode={mode} stores={len(outcomes)} failed={failed}\n")
    return EXIT_STORE_FAILED if failed else EXIT_CLEAN


def main(argv: Sequence[str] | None = None) -> int:
    """Configure content-free logging, run the sweep, and return its exit code."""
    configure_logging()
    return asyncio.run(_run_and_dispose(argv))


async def _run_and_dispose(argv: Sequence[str] | None) -> int:
    """Run the sweep, then close the engine's connections before the loop ends."""
    try:
        return await run(argv)
    finally:
        await engine.dispose()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
