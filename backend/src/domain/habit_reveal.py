"""The calendar offers each program habit once; a decline is respected forever.

Issue #2576. Until this module existed nothing ever revealed a habit but the
user: ``PUT /habits/{id}`` with ``revealed=true``, the Habits screen's unlock
affordances, or a Return re-commit. That was a ratified decision (#1332 /
PR #1349, "nothing auto-unlocks") and it produced the stall the issue
describes: once a person stops unlocking by hand, the habits past Blue never
appear. The owner ruling of 2026-09-06 reversed it -- **calendar/stage
eligibility auto-reveals each habit once; a persisted one-shot marker prevents
re-revealing after a manual relock; habits released in an active Metta Return
arc stay paused until recommit** -- and this module is that ruling.

**Why the slot and not the stage text or the start date.** ``Habit.stage`` is a
colour name the client writes (``stageAtIndex``) while the server's stage
authority speaks in numbers, and ``start_date`` is user-editable, defaults to
"now" on every add (so it would self-reveal), and sits outside the cadence for
carryover habits. The client keeps ``sort_order`` dense from 0 within each
partition and derives the colour from that very index, so the 0-based slot IS
the habit's stage key: for a dense partition ``sort_order < open_through`` is
exactly "1-based position <= the highest open stage". A habit with no slot has
no position the calendar can open and is never revealed.

**Why it is a one-shot.** ``NORTH-STAR.md`` line 34 says the cadence governs
when a habit is *offered*; lines 38 and 62 require every invitation to be
declinable in one tap and never to repeat as nagging. An unlocked tile the
person may ignore, long-press, relock, or switch is the offer, and the
``auto_revealed_at`` stamp is what makes the decline stick: once set, the row
never matches the predicate again, whatever ``revealed`` later says. Nothing
here revokes -- the flip only ever widens access, the same contract as
:func:`domain.stage_authority.open_through`.

**Commit contract.** One ``UPDATE`` scoped to the caller, committed only when a
row changed. Like :func:`domain.stage_authority.record_stage_entry` it is meant
to be the first statement of its endpoint so the commit carries nothing else.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, cast

from sqlalchemy import CursorResult, update
from sqlmodel import col, select

from domain.stage_authority import open_through
from domain.stage_progress import get_user_progress
from models.habit import Habit
from models.metta_return_habit_release import MettaReturnHabitRelease

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

__all__ = ["reveal_habits_the_calendar_opened"]


async def reveal_habits_the_calendar_opened(
    session: AsyncSession,
    user_id: int,
    *,
    tz: str | None,
) -> int:
    """Reveal, once each, the caller's program habits whose slot the calendar has opened.

    Eligibility is :func:`domain.stage_authority.open_through` for the caller's
    progress row (``FIRST_STAGE`` when there is none), computed in ``tz`` so the
    server counts the same local midnights the client does. A row is flipped
    when it is the caller's, on the program partition, still locked, never
    auto-revealed before, slotted below the open stage, and not resting in a
    live Return release (a release row with ``recommitted_at`` NULL). Returns
    the number of habits revealed; commits only when that is non-zero.
    """
    progress = await get_user_progress(session, user_id)
    opened = open_through(progress, tz=tz)
    resting = select(col(MettaReturnHabitRelease.habit_id)).where(
        col(MettaReturnHabitRelease.user_id) == user_id,
        col(MettaReturnHabitRelease.recommitted_at).is_(None),
    )
    statement = (
        update(Habit)
        .where(
            col(Habit.user_id) == user_id,
            col(Habit.is_carryover).is_(False),
            col(Habit.revealed).is_(False),
            col(Habit.auto_revealed_at).is_(None),
            col(Habit.sort_order).is_not(None),
            col(Habit.sort_order) < opened,
            col(Habit.id).not_in(resting),
        )
        .values(revealed=True, auto_revealed_at=datetime.now(UTC))
        .execution_options(synchronize_session=False)
    )
    # ``execute`` is typed ``Result``; an UPDATE yields a ``CursorResult`` whose
    # ``rowcount`` is the number of habits flipped.
    revealed = int(cast("CursorResult[Any]", await session.execute(statement)).rowcount)
    if revealed > 0:
        await session.commit()
    return revealed
