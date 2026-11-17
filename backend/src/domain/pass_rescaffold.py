"""Energy Scaffolding opens a pass on the day the person chooses (issue #3725).

Re-running Energy Scaffolding starts a new pass through the stages. The person
picks its start day, from the back-date floor up to one program ahead
(:mod:`domain.program_start`), in any cycle.

**A day that has already come** opens the pass at once: the running pass is
closed the day before it (:func:`domain.program_pass.open_next_pass`), the
cycle loops exactly as begin-again's does (:func:`loop_to_next_cycle`), and the
record is put in the window the new anchor opens as of now.

**A day still ahead** is held on ``StageProgress.pending_pass_starts_on``. The
running pass keeps running until the day before it -- epic #3722 decision 2,
so there is no dead period -- and keeps answering every reader
(:func:`domain.program_calendar.effective_anchor`). It is closed with the stage
and week it ACTUALLY reached on the first read on or after the day
(:func:`settle_pending_pass`), never at save time. A second save while one is
pending replaces it; there is never more than one.

Why a pending day and not a pending ``programpass`` row: a row with
``ended_on`` NULL means "running" to every reader of that table, the unlock log
included, and a pass that has not begun is not running. The row is written the
day the pass actually opens, with the start it was given.

Every writer here mutates and never commits: callers hold the
``StageProgress`` row lock and own the transaction, except
:func:`settle_pending_pass`, which takes the lock and commits for read paths.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import TYPE_CHECKING

from domain.dates import day_bounds_in_tz, ensure_aware, to_user_date
from domain.program_calendar import resolve_program_anchor
from domain.program_pass import open_next_pass
from domain.stage_authority import FIRST_STAGE, reanchor_program
from models.program_pass import PassOrigin

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from models.stage_progress import StageProgress

__all__ = [
    "arrive_pending_pass",
    "loop_to_next_cycle",
    "open_pass_on",
    "pending_pass_due",
    "settle_pending_pass",
]


def _padded_anchors(existing: StageProgress) -> list[str | None]:
    """The row's retained anchors, left-padded with ``None`` to one per past cycle.

    ``past_cycle_anchors`` holds one element per cycle already left behind, so a
    row that looped before #2894 shipped is short by exactly the number of
    anchors that were destroyed. Padding to ``cycle_number - 1`` before the new
    anchor is appended is what makes "element ``i`` is cycle ``i + 1``'s start"
    true BY CONSTRUCTION rather than by convention, and each pad records an
    anchor that is unknown and not recoverable — never one that was guessed.
    """
    retained = list(existing.past_cycle_anchors or [])
    missing = max(0, existing.cycle_number - 1 - len(retained))
    return [None] * missing + retained


def _retained_anchors(existing: StageProgress) -> list[str | None]:
    """``existing``'s past-cycle anchors extended with the OUTGOING cycle's own.

    Reads ``cycle_number`` BEFORE the loop bumps it, so the appended anchor lands
    at the index of the cycle it actually belongs to. ``ensure_aware`` normalizes
    the read — SQLite hands a ``DateTime(timezone=True)`` column back naive — so
    the stored string always carries its UTC offset.
    """
    anchor = ensure_aware(resolve_program_anchor(existing))
    return [*_padded_anchors(existing), anchor.isoformat()]


def loop_to_next_cycle(existing: StageProgress, anchor: datetime) -> None:
    """Mutate ``existing`` in place into the next cycle, starting at ``anchor``.

    Retains the OUTGOING cycle's calendar anchor on ``past_cycle_anchors``
    first (issue #2894), then resets the calendar anchors (``stage_started_at``
    + ``program_started_at``) to ``anchor`` so the fresh cycle restarts its
    schedule instead of instantly re-unlocking every stage, bumps
    ``cycle_number``, clears ``completed_stages`` back to stage 1 and drops any
    pending pass -- the cycle it was pending against is over. No engagement
    data is touched.

    Order is load-bearing twice over. The retention reads the pre-bump
    ``cycle_number``, so appending after the bump would file every anchor one
    cycle late. And the retention is a REBIND, never an in-place ``.append``:
    SQLAlchemy does not track mutation of a plain JSON column, so an append is
    silently discarded by the caller's commit. Both writes ride the caller's
    one commit and ``FOR UPDATE`` row lock, so there is no instant in which the
    cycle advanced and its anchor did not survive.

    Shared by begin-again (``anchor`` is now) and a scaffolding re-run (the
    local midnight of the chosen day): a new pass is a new cycle either way, so
    the outgoing cycle's recorded end -- the incoming anchor -- stays true.
    """
    existing.past_cycle_anchors = _retained_anchors(existing)
    existing.cycle_number += 1
    existing.current_stage = FIRST_STAGE
    existing.completed_stages = []
    existing.stage_started_at = anchor
    existing.program_started_at = anchor
    existing.pending_pass_starts_on = None


async def open_pass_on(
    session: AsyncSession,
    progress: StageProgress,
    start_day: date,
    *,
    now: datetime,
    tz: str,
) -> None:
    """Open a ``rescaffold`` pass on ``start_day`` (today or earlier) as of ``now``.

    Closes the running pass the day before, loops the cycle onto the day's
    local midnight, then puts the record in the window that anchor opens as of
    ``now`` -- a back-dated day can land past stage 1, exactly as the
    first-cycle PUT's re-anchor does. Mutates; the caller holds the lock and
    commits.
    """
    await open_next_pass(
        session, progress, started_on=start_day, origin=PassOrigin.RESCAFFOLD, tz=tz
    )
    anchor, _ = day_bounds_in_tz(tz, start_day)
    loop_to_next_cycle(progress, anchor)
    reanchor_program(progress, anchor, now, tz=tz)


def pending_pass_due(progress: StageProgress, today: date) -> bool:
    """Whether a pending pass's day has come by ``today`` (the person's own day)."""
    pending = progress.pending_pass_starts_on
    return pending is not None and pending <= today


async def arrive_pending_pass(
    session: AsyncSession, progress: StageProgress, *, now: datetime, tz: str
) -> bool:
    """Open ``progress``'s pending pass if its day has come; report whether it did.

    The running pass is closed the day before the pending day -- not the day
    before today -- so what it reached is measured to the day it really ended,
    however late the first read after it comes. Mutates; the caller holds the
    ``FOR UPDATE`` lock and commits.
    """
    pending = progress.pending_pass_starts_on
    if pending is None or not pending_pass_due(progress, to_user_date(tz, ensure_aware(now))):
        return False
    await open_pass_on(session, progress, pending, now=now, tz=tz)
    return True


async def settle_pending_pass(
    session: AsyncSession,
    progress: StageProgress,
    *,
    tz: str,
    now: datetime | None = None,
) -> StageProgress:
    """Open an arrived pending pass for a read path, and commit; else return untouched.

    The read paths that mean a person is present -- the Map, the Course, the
    habit list -- call this first, so the pass closes on the first of them on
    or after the day. The common case (nothing pending, or not yet due) costs
    one comparison and no query.

    When a write is due the row is re-read under ``FOR UPDATE`` and the check
    repeated against the locked copy, so two concurrent reads cannot open the
    pass twice. The commit is the whole session's: as with
    :func:`domain.stage_authority.record_stage_entry`, callers must hold no
    uncommitted writes across this call.
    """
    moment = now if now is not None else datetime.now(UTC)
    if not pending_pass_due(progress, to_user_date(tz, ensure_aware(moment))):
        return progress
    await session.refresh(progress, with_for_update=True)
    if not await arrive_pending_pass(session, progress, now=moment, tz=tz):
        return progress
    session.add(progress)
    await session.commit()
    await session.refresh(progress)
    return progress
