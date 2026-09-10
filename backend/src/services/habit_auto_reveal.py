"""One-shot reconciliation of habits whose program invitation has arrived."""

from __future__ import annotations

from datetime import UTC, date, datetime

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.dates import to_user_date
from domain.frequencies import frequency_for_color
from domain.stage_authority import open_through
from domain.stage_progress import get_user_progress
from models.habit import Habit
from models.metta_return_habit_release import MettaReturnHabitRelease


def _stage_number(colour: str) -> int | None:
    """Return the canonical 1-based stage number for a habit colour."""
    frequency = frequency_for_color(colour)
    return None if frequency is None else int(frequency.value.removeprefix("F"))


def _is_open(habit: Habit, *, local_today: date, open_stage: int) -> bool:
    """Whether the program's invitation has reached ``habit``.

    The two signals are not two independent invitations that either may issue
    (issue #2765). They answer for **different habits**. A habit whose ``stage``
    names one of the ten rings has a rung on the ladder, and the ladder is the
    only authority for when that rung opens: ``open_through`` already unions the
    calendar's offer with the record's entry, so a stage inside it *is* "the
    schedule has arrived here". A habit whose ``stage`` names no ring -- the
    column's own default is the empty string, and a user may write anything into
    it -- has no rung to wait for, and its start date is the only schedule it
    has.

    Reading them as alternatives let the date clause speak for laddered habits
    too, and on an established account every habit's ``start_date`` lies in the
    past, so every ring opened at once and graduated unlock stopped tracking the
    user's level. Requiring the stage gate for laddered habits is the issue's
    suggested default: ``stage <= open_stage and (start_date <= today or stage
    is open)`` reduces to ``stage <= open_stage``, because the right-hand
    disjunction is already implied. Scoping the date clause to habits off the
    ladder is its alternative suggestion, and the two compose rather than
    compete.

    Forward scheduling is untouched: a laddered habit still opens the day its
    ring does, whether the date is ahead of that day or behind it, and an
    unladdered habit still opens on its start date and not before.
    """
    stage = _stage_number(habit.stage)
    if stage is None:
        return habit.start_date <= local_today
    return stage <= open_stage


async def _unconsumed_candidates(session: AsyncSession, user_id: int) -> list[Habit]:
    """Read regular habits whose automatic invitation is still unconsumed."""
    result = await session.execute(
        select(Habit)
        .where(
            Habit.user_id == user_id,
            col(Habit.is_carryover).is_(False),
            col(Habit.auto_revealed_at).is_(None),
        )
        .order_by(col(Habit.id))
    )
    return list(result.scalars().all())


async def _locked_candidates(
    session: AsyncSession, user_id: int, habit_ids: list[int]
) -> list[Habit]:
    """Re-read only prospective writes under a row lock."""
    if not habit_ids:
        return []
    result = await session.execute(
        select(Habit)
        .where(
            Habit.user_id == user_id,
            col(Habit.id).in_(habit_ids),
            col(Habit.is_carryover).is_(False),
            col(Habit.auto_revealed_at).is_(None),
        )
        .order_by(col(Habit.id))
        .with_for_update()
    )
    return list(result.scalars().all())


async def _live_release_ids(session: AsyncSession, user_id: int, habit_ids: list[int]) -> set[int]:
    """Return candidate ids held by an unrecommitted Metta Return release."""
    result = await session.execute(
        select(MettaReturnHabitRelease.habit_id).where(
            MettaReturnHabitRelease.user_id == user_id,
            col(MettaReturnHabitRelease.recommitted_at).is_(None),
            col(MettaReturnHabitRelease.habit_id).in_(habit_ids),
        )
    )
    return set(result.scalars().all())


def _newly_open(
    candidates: list[Habit],
    released_ids: set[int],
    *,
    local_today: date,
    open_stage: int,
) -> list[Habit]:
    """Filter locked candidates to invitations that may be consumed now."""
    return [
        habit
        for habit in candidates
        if habit.id not in released_ids
        and _is_open(habit, local_today=local_today, open_stage=open_stage)
    ]


async def _persist_reveals(session: AsyncSession, habits: list[Habit], moment: datetime) -> int:
    """Stamp and commit ``habits``; leave an empty read transaction untouched."""
    if not habits:
        return 0
    for habit in habits:
        habit.revealed = True
        habit.auto_revealed_at = moment
    session.add_all(habits)
    await session.commit()
    return len(habits)


async def _open_candidates(
    session: AsyncSession,
    user_id: int,
    user_tz: str,
    candidates: list[Habit],
    moment: datetime,
) -> list[Habit]:
    """Resolve calendar standing and Return releases for locked candidates."""
    if not candidates:
        return []
    progress = await get_user_progress(session, user_id)
    open_stage = open_through(progress, moment, tz=user_tz)
    candidate_ids = [habit.id for habit in candidates if habit.id is not None]
    released_ids = await _live_release_ids(session, user_id, candidate_ids)
    return _newly_open(
        candidates,
        released_ids,
        local_today=to_user_date(user_tz, moment),
        open_stage=open_stage,
    )


async def reconcile_habit_auto_reveals(
    session: AsyncSession,
    user_id: int,
    user_tz: str,
    *,
    now: datetime | None = None,
) -> int:
    """Persist every newly eligible habit reveal for ``user_id`` exactly once.

    Eligibility is checked without a lock first; only the rows that might be
    written are re-read under a lock and revalidated. This keeps the common
    no-op list read free of row locks while concurrent reads still cannot
    consume the same invitation twice. A live Metta Return release is an
    explicit pause and wins over eligibility until the user recommits.
    Already-revealed eligible rows are stamped too: the marker
    records that their automatic invitation has been consumed, allowing a
    future manual re-lock to remain locked.
    """
    moment = now or datetime.now(UTC)
    candidates = await _unconsumed_candidates(session, user_id)
    prospective = await _open_candidates(session, user_id, user_tz, candidates, moment)
    prospective_ids = [habit.id for habit in prospective if habit.id is not None]
    if not prospective_ids:
        return 0
    locked = await _locked_candidates(session, user_id, prospective_ids)
    opened = await _open_candidates(session, user_id, user_tz, locked, moment)
    return await _persist_reveals(session, opened, moment)
