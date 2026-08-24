"""One rule for two answers: the calendar offers, the record remembers.

Two things in this codebase can answer "what stage is this person in" --
:func:`domain.program_calendar.calendar_stage`, which walks
``STAGE_DURATIONS_DAYS`` from the person's program anchor, and
``StageProgress.current_stage``, which persists a number. Until this module
existed there was no rule saying which of them wins and nothing that moved the
persisted one: the only code that could advance it sat behind a client-driven
``PUT`` no client ever called, so in the shipped app nobody left stage 1.

**The calendar is the authority for what is offered.** ``NORTH-STAR.md`` line 34
states the progression model outright -- one 36-week cadence, eight stages of
three weeks then two of six -- and says that cadence is what "governs when
prompts shift, when a new habit is offered, when the practice steps up, and how
the reading drips". That is a schedule, not an achievement and not a button, and
:data:`domain.constants.STAGE_DURATIONS_DAYS` is that sentence transcribed. Ten
positions, non-uniform: reasoning "36 weeks over 3 weeks each" yields twelve and
is the known wrong turn.

**The record is the authority for what has been entered.** It is not a cache of
the calendar and it is not refreshed on read. Someone who ignores the app for two
months has not *lived* stages 3 and 4 because the calendar passed them, and
saying otherwise would let the history, the wheel and the Return read back a
participation that never happened. So the record moves when the person shows up
inside a window the calendar has already opened -- :func:`record_stage_entry`,
called by the read paths that mean someone is present -- and not otherwise. No
client asks for it and no client may assert it.

**Nothing gates on the gap, and that is the load-bearing constraint.**
``NORTH-STAR.md`` line 18 -- nothing is gated behind anything else. A record that
lags the calendar must never withhold what the calendar has already opened, so
every access decision runs through :func:`open_through`, the *union* of the two
answers, never the record alone. The union also runs the other way: a row that
advancement left ahead of its window keeps what it was granted, because time may
widen access and may never revoke it.

**Both answers reset together or they diverge for good.** The begin-again loop
(``routers.stages.begin_again``) re-anchors ``program_started_at`` at the same
moment it returns the record to stage 1; move one without the other and the
second lap is over before it starts -- the next read would re-record entry into
stage 10 from the stale anchor.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from domain.program_calendar import calendar_stage, resolve_program_anchor

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from models.stage_progress import StageProgress

__all__ = [
    "StageStanding",
    "open_through",
    "record_stage_entry",
    "stage_standing",
]

#: Where a person with no progress row at all stands. Not "nowhere": the
#: program's first stage is open to everyone from the first screen.
FIRST_STAGE = 1


@dataclass(frozen=True)
class StageStanding:
    """The two answers, side by side and still distinguishable.

    ``offered`` is the stage the calendar has opened; ``entered`` is the stage
    the record says the person has actually stepped into. They are kept apart
    rather than collapsed because every consumer wants a different one of them:
    pacing wants the offer, history and the Return want the entry, and access
    wants :func:`open_through`'s union of both.
    """

    offered: int
    entered: int

    @property
    def is_lagging(self) -> bool:
        """Whether the calendar has moved on without the person.

        False when the two agree *and* when the record runs ahead: a row past
        its window is not behind anything.
        """
        return self.entered < self.offered


def stage_standing(
    progress: StageProgress,
    now: datetime | None = None,
    *,
    tz: str | None = None,
) -> StageStanding:
    """Read both answers for ``progress`` as of ``now``.

    The offer is computed in ``tz`` (UTC when None) so the server counts the
    same local midnights the client does and never reports a window shut that
    the user can see is open.
    """
    return StageStanding(
        offered=calendar_stage(resolve_program_anchor(progress), now, tz=tz),
        entered=progress.current_stage,
    )


def open_through(
    progress: StageProgress | None,
    now: datetime | None = None,
    *,
    tz: str | None = None,
) -> int:
    """The highest stage open to this person -- the union of both answers.

    The only expression of "nothing gates on the gap" that access decisions may
    use. A row is open through whichever of the calendar and the record reaches
    further, so a lagging record withholds nothing and an early record loses
    nothing. Someone with no row yet stands at :data:`FIRST_STAGE`.
    """
    if progress is None:
        return FIRST_STAGE
    standing = stage_standing(progress, now, tz=tz)
    return max(standing.offered, standing.entered)


def _enter(progress: StageProgress, stage_number: int, entered_at: datetime) -> None:
    """Move the record into ``stage_number`` as of ``entered_at``.

    ``completed_stages`` is filled to ``{1..stage_number-1}`` because the row's
    structural invariant is contiguity -- ``domain.stage_progress.completed_stage_gap``
    and the admin repair endpoint both enforce it -- not because the person is
    being credited with having engaged those stages. What they actually did
    inside a stage is measured by ``compute_stage_progress``, which reads
    habits, practice and course rows and knows nothing of this column.
    """
    progress.current_stage = stage_number
    progress.completed_stages = list(range(FIRST_STAGE, stage_number))
    progress.highest_stage_reached = max(progress.highest_stage_reached, stage_number)
    progress.stage_started_at = entered_at


async def record_stage_entry(
    session: AsyncSession,
    progress: StageProgress,
    now: datetime | None = None,
    *,
    tz: str | None = None,
) -> StageProgress:
    """Record entry into the window the caller is standing in, and commit.

    The server-side derivation the app never had: called from the read paths
    that mean a person is present, it advances the record to the calendar's
    current stage without any client asking and without any client able to ask
    for more. The record can therefore never run past the schedule -- there is
    no payload to skip with.

    Idempotent within a window: a second read in the same stage re-records
    nothing, so ``stage_started_at`` keeps the moment the threshold was actually
    crossed. A row already at or beyond the calendar returns untouched, which is
    the ordinary case and costs one comparison and no write.

    When a write is due the row is re-read under ``FOR UPDATE`` and the standing
    recomputed against the locked copy, so a concurrent begin-again cannot have
    its reset overwritten from this caller's stale anchor.

    That commit is the whole session's, not this row's, so callers must not hold
    uncommitted writes across this call -- the same contract
    :func:`domain.stage_progress.ensure_user_progress` states, and for the same
    reason: the locked re-read has to see committed state. Every call site today
    is the first statement of its endpoint, which is what keeps that free.
    """
    if not stage_standing(progress, now, tz=tz).is_lagging:
        return progress
    await session.refresh(progress, with_for_update=True)
    standing = stage_standing(progress, now, tz=tz)
    if not standing.is_lagging:
        return progress
    _enter(progress, standing.offered, now if now is not None else datetime.now(UTC))
    session.add(progress)
    await session.commit()
    await session.refresh(progress)
    return progress
