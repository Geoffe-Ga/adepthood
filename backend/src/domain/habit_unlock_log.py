"""The habit unlock log: writing each lock-state change, and reading the latest unlock (#3724).

Three writers flip ``Habit.revealed`` on a program habit -- a manual
``PUT /habits/{id}``, the habit list's auto-reveal, and a create that arrives
unlocked. Each calls :func:`record_lock_changes` after the flip and before its
own commit, so the log row lands in the same transaction as the change it
describes. The writer mutates and ``add``s but never commits.

Every query is scoped by ``user_id``: the pass looked up is the caller's live
pass, and a habit's program number counts only the caller's own habits.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, cast

from sqlmodel import col, select

from domain.dates import ensure_aware, to_user_date
from domain.program_pass import live_pass
from models.habit import Habit
from models.habit_unlock_event import HabitUnlockEvent, UnlockKind, UnlockSource

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

__all__ = ["LockChange", "latest_unlocks", "program_numbers", "record_lock_changes"]


def _recency(event: HabitUnlockEvent) -> tuple[datetime, int]:
    """Order events by when they happened, ties going to the later write.

    ``ensure_aware`` because SQLite reads a timezone-aware column back naive,
    and a naive and an aware instant cannot be compared.
    """
    return ensure_aware(event.occurred_at), event.id or 0


def _is_unlock_in(event: HabitUnlockEvent, pass_id: int) -> bool:
    """Whether ``event`` is an unlock that happened in pass ``pass_id``."""
    return event.pass_id == pass_id and event.kind == UnlockKind.UNLOCKED


def latest_unlocks(events: Iterable[HabitUnlockEvent], pass_id: int) -> dict[int, HabitUnlockEvent]:
    """Per habit, the most recent ``unlocked`` event in pass ``pass_id``.

    A habit whose latest event in the pass is a re-lock still answers with its
    most recent unlock: the ribbon marks the most recent unlock date there is.
    A habit with no unlock in the pass is absent from the result.
    """
    in_pass = sorted((event for event in events if _is_unlock_in(event, pass_id)), key=_recency)
    # Ascending, so each habit's latest unlock is the last one written to the dict.
    return {event.habit_id: event for event in in_pass}


async def program_numbers(session: AsyncSession, user_id: int) -> dict[int, int]:
    """Each of ``user_id``'s program habits mapped to its 1-based program number.

    The order is the habit list's own: unnumbered legacy rows first, then
    ascending ``sort_order``, ties broken by ``id``. Carryover habits are not on
    the program and are not counted.
    """
    result = await session.execute(
        select(Habit.id)
        .where(col(Habit.user_id) == user_id, col(Habit.is_carryover).is_(False))
        .order_by(col(Habit.sort_order).asc().nulls_first(), col(Habit.id).asc())
    )
    return {habit_id: number for number, habit_id in enumerate(result.scalars().all(), start=1)}


async def _live_pass_id(session: AsyncSession, user_id: int) -> int | None:
    """The id of ``user_id``'s live pass, or ``None`` when no pass is recorded."""
    current = await live_pass(session, user_id)
    return None if current is None else current.id


@dataclass(frozen=True, slots=True)
class LockChange:
    """Who flipped the lock, and when, as the account perceives the day."""

    source: UnlockSource
    moment: datetime
    tz: str


def _event_for(
    habit: Habit, numbers: dict[int, int], pass_id: int | None, change: LockChange
) -> HabitUnlockEvent:
    """The log row for ``habit``'s lock as it now stands (flushed, so it has an id)."""
    habit_id = cast("int", habit.id)
    return HabitUnlockEvent(
        user_id=habit.user_id,
        habit_id=habit_id,
        pass_id=pass_id,
        kind=UnlockKind.UNLOCKED if habit.revealed else UnlockKind.RELOCKED,
        occurred_at=change.moment,
        local_day=to_user_date(change.tz, change.moment),
        program_number=numbers[habit_id],
        source=change.source,
    )


async def record_lock_changes(
    session: AsyncSession, user_id: int, habits: Sequence[Habit], change: LockChange
) -> list[HabitUnlockEvent]:
    """Log the lock state each of ``user_id``'s ``habits`` was just flipped to.

    Call AFTER the flip: the event's kind is read from ``habit.revealed`` and
    its program number from the habits as they now stand, so a request that
    moves and unlocks a habit at once records where it was unlocked. The caller
    decides that the flag actually changed and that ``habits`` are
    ``user_id``'s; carryover habits are skipped here, because they are not on
    the ribbon. Writes run inside the caller's transaction and are not committed.
    """
    program = [habit for habit in habits if not habit.is_carryover]
    if not program:
        return []
    await session.flush()
    numbers = await program_numbers(session, user_id)
    pass_id = await _live_pass_id(session, user_id)
    events = [_event_for(habit, numbers, pass_id, change) for habit in program]
    session.add_all(events)
    return events
