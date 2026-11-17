"""The lifecycle of a pass through the stages (issue #3723).

A pass opens when the account's progress row is first provisioned and again
every time begin-again runs; begin-again also closes the pass it leaves. Closing
records the last day the pass ran -- the day before the next one starts -- and
how far it got, measured from the pass's OWN ``started_on`` by
:func:`close_pass`. The live anchor is never consulted for a closed pass: by the
time a pass closes, that anchor already belongs to the pass after it.

Every query here is scoped by ``user_id``. The writers mutate and ``add`` but
never commit: their callers hold the ``StageProgress`` row lock and own the
transaction, so the pass record moves in the same commit as the cycle it
describes.
"""

from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from itertools import accumulate
from typing import TYPE_CHECKING

from sqlalchemy import func
from sqlmodel import col, select

from domain.constants import DAYS_PER_WEEK, STAGE_DURATIONS_DAYS
from domain.dates import ensure_aware, to_user_date
from domain.program_calendar import resolve_program_anchor
from models.program_pass import PassOrigin, ProgramPass

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from models.stage_progress import StageProgress

__all__ = [
    "PROGRAM_CALENDAR",
    "PassCalendar",
    "begin_next_pass",
    "close_pass",
    "first_pass",
    "live_pass",
    "move_live_pass_start",
]

#: The number every account's first pass carries.
_FIRST_PASS_NUMBER = 1
_ONE_DAY = timedelta(days=1)


@dataclass(frozen=True, slots=True)
class PassCalendar:
    """The stage schedule a pass is measured against.

    The program's own schedule is :data:`PROGRAM_CALENDAR`; the type exists so
    :func:`close_pass` takes its measure as an argument rather than reaching for
    module state, which keeps the arithmetic checkable against any schedule.
    """

    stage_durations_days: tuple[int, ...] = STAGE_DURATIONS_DAYS

    @property
    def total_days(self) -> int:
        """How many days the whole program runs."""
        return sum(self.stage_durations_days)

    @property
    def total_weeks(self) -> int:
        """How many weeks the whole program runs."""
        return self.total_days // DAYS_PER_WEEK

    def stage_on(self, elapsed: int) -> int:
        """The 1-based stage the 0-based program day ``elapsed`` falls in, clamped to the last.

        Counting the stage openings at or before ``elapsed`` IS the 1-based stage:
        day 0 sits past only stage 1's opening. Past the final day the count stops
        at the number of stages, which is the clamp.
        """
        openings = (0, *accumulate(self.stage_durations_days[:-1]))
        return bisect_right(openings, elapsed)

    def week_on(self, elapsed: int) -> int:
        """The 1-based week the 0-based program day ``elapsed`` falls in, clamped to the last."""
        return min(elapsed // DAYS_PER_WEEK + 1, self.total_weeks)


#: The curriculum's own schedule: ten stages over thirty-six weeks.
PROGRAM_CALENDAR = PassCalendar()


def close_pass(pass_: ProgramPass, *, ended_on: date, calendar: PassCalendar) -> ProgramPass:
    """End ``pass_`` on ``ended_on`` and record how far it got; mutates and returns it.

    ``ended_on`` is the LAST day the pass ran, so the program day it reached is
    the whole days between its own ``started_on`` and ``ended_on``. ``completed``
    is true only when that day is the final day of stage 10 or later; anything
    shorter is a partial completion.

    A pass left on the day it began ends the day BEFORE it began -- the end is
    always the day before the next pass starts, so passes never share a day.
    It ran no days at all and is measured as the first day of stage 1.
    """
    elapsed = max(0, (ended_on - pass_.started_on).days)
    pass_.ended_on = ended_on
    pass_.reached_stage = calendar.stage_on(elapsed)
    pass_.reached_week = calendar.week_on(elapsed)
    pass_.completed = elapsed >= calendar.total_days - 1
    return pass_


def first_pass(user_id: int, *, started_on: date) -> ProgramPass:
    """The live pass 1 a freshly provisioned progress row opens."""
    return ProgramPass(
        user_id=user_id,
        pass_number=_FIRST_PASS_NUMBER,
        started_on=started_on,
        origin=PassOrigin.FIRST_RUN,
    )


async def live_pass(session: AsyncSession, user_id: int) -> ProgramPass | None:
    """``user_id``'s live (not yet ended) pass, or ``None`` when none is recorded."""
    result = await session.execute(
        select(ProgramPass)
        .where(col(ProgramPass.user_id) == user_id, col(ProgramPass.ended_on).is_(None))
        .order_by(col(ProgramPass.pass_number).desc())
        .limit(1)
    )
    return result.scalars().first()


async def _highest_pass_number(session: AsyncSession, user_id: int) -> int:
    """The highest pass number ``user_id`` has recorded, or 0 for none."""
    result = await session.execute(
        select(func.max(ProgramPass.pass_number)).where(col(ProgramPass.user_id) == user_id)
    )
    return result.scalar() or 0


async def move_live_pass_start(session: AsyncSession, user_id: int, started_on: date) -> None:
    """Carry the live pass to a re-picked first-cycle start date.

    The live pass starts on the day the program does, so when the person picks
    a different start for their first cycle the pass moves with it. A row with
    no recorded pass is left alone: begin-again records it from the live anchor
    when the pass closes.
    """
    current = await live_pass(session, user_id)
    if current is not None:
        current.started_on = started_on
        session.add(current)


async def begin_next_pass(
    session: AsyncSession, progress: StageProgress, *, now: datetime, tz: str
) -> ProgramPass:
    """Close ``progress``'s live pass and open the next, both dated in ``tz``.

    Call BEFORE the cycle loop rewrites ``progress``: a row that has no live
    pass recorded -- one written by a build that predates this table -- has its
    outgoing pass recorded from the still-current anchor and cycle number (as a
    backfill) before it is closed, so the loop never drops the pass it ends.

    The incoming pass starts on ``now``'s day and the outgoing one ends the day
    before. Numbering continues past the highest recorded pass.
    """
    today = to_user_date(tz, ensure_aware(now))
    highest = await _highest_pass_number(session, progress.user_id)
    outgoing = await live_pass(session, progress.user_id)
    if outgoing is None:
        outgoing = ProgramPass(
            user_id=progress.user_id,
            pass_number=max(progress.cycle_number, highest + 1),
            started_on=to_user_date(tz, ensure_aware(resolve_program_anchor(progress))),
            origin=PassOrigin.BACKFILL,
        )
    close_pass(outgoing, ended_on=today - _ONE_DAY, calendar=PROGRAM_CALENDAR)
    incoming = ProgramPass(
        user_id=progress.user_id,
        pass_number=max(highest, outgoing.pass_number) + 1,
        started_on=today,
        origin=PassOrigin.BEGIN_AGAIN,
    )
    session.add_all([outgoing, incoming])
    return incoming
