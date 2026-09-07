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
    """Whether either independent program invitation has reached ``habit``."""
    stage = _stage_number(habit.stage)
    return habit.start_date <= local_today or (stage is not None and stage <= open_stage)


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
    explicit pause and wins over both eligibility paths until the user
    recommits. Already-revealed eligible rows are stamped too: the marker
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
