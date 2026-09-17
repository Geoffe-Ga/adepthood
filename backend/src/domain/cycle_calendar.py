"""Per-cycle program calendars — the anchor a PAST cycle's reviews belong to.

:mod:`domain.program_calendar` answers "where is this user NOW", which by
construction means the cycle they are living in. This module answers the other
question the reflection feed has to ask: which stretch of calendar did cycle
``k`` occupy, so a review written back then can be re-windowed against the days
it was actually written about.

``POST /stages/begin-again`` re-stamps ``program_started_at`` for the fresh
cycle and retains the outgoing one on ``StageProgress.past_cycle_anchors``
(issue #2894). Element ``i`` of that list is cycle ``i + 1``'s program start, so
cycle ``k``'s END is element ``k`` — or, for the newest past cycle, the live
``program_started_at`` — because the loop writes one ``now`` to both. Nothing
here ever invents a bound: an anchor destroyed before #2894 shipped resolves to
:data:`CycleAnchorStatus.UNRECORDED` and the caller says so, rather than
serving a plausible-looking wrong period.

The clamp is deliberately MIDNIGHT-ALIGNED.
:func:`domain.program_calendar.program_week_bounds` derives both of its bounds
from local midnights, and the successor cycle's week 1 therefore opens at the
local midnight of the loop DAY. Clamping a closed cycle at the raw loop instant
would leave the morning of that day inside two cycles at once and publish a
non-midnight bound the response schema promises is a midnight — which is the
clock-mixing defect of issue #2886 arriving from the other direction.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import TYPE_CHECKING

from domain.dates import day_bounds_in_tz, ensure_aware, to_user_date
from domain.program_calendar import program_week_bounds, resolve_program_anchor

if TYPE_CHECKING:
    from models.stage_progress import StageProgress

logger = logging.getLogger(__name__)

# The lowest cycle number that can name a real cycle; ``c0:``/negative keys are
# outside the grammar's intent and resolve to "unknown" rather than indexing.
_FIRST_CYCLE = 1


class CycleAnchorStatus(StrEnum):
    """Why a scope does or does not have a calendar window — total, never null.

    The four members are the four distinct causes, kept apart so a client can
    say the true thing about each instead of collapsing them into one empty
    feed:

    * ``RECORDED`` — the cycle's anchor is known and the window is real.
    * ``UNRECORDED`` — the cycle happened, but its anchor was destroyed by
      begin-again before #2894 and is NOT recoverable. There is no history
      table to restore it from, and every approximation available (the earliest
      habit start date, the timestamps of surviving reviews) would fabricate a
      window, so it is deliberately refused.
    * ``UNSTARTED`` — the caller has not reached that cycle yet.
    * ``NO_PROGRAM`` — the caller has no ``StageProgress`` row, so no calendar.
    """

    RECORDED = "recorded"
    UNRECORDED = "unrecorded"
    UNSTARTED = "unstarted"
    NO_PROGRAM = "no_program"


@dataclass(frozen=True)
class CycleWindow:
    """The stretch of calendar one cycle occupied.

    ``ended_at`` is ``None`` only for the cycle the user is currently living
    in — it has not closed, so its weeks run on. Every past cycle carries the
    instant its successor began, which is the same instant it ended.
    """

    cycle_number: int
    started_at: datetime
    ended_at: datetime | None


def _parsed_anchor(raw: str | None, *, cycle: int) -> datetime | None:
    """Parse one stored anchor, or None when it is unknown or unparseable.

    A corrupt string degrades this one cycle to "unknown" rather than 500-ing
    the whole feed, the same posture the reflections router takes towards an
    unparseable scope key. The warning names the cycle number ONLY — never a
    journal body, a title, or anything the user wrote.
    """
    if raw is None:
        return None
    try:
        return ensure_aware(datetime.fromisoformat(raw))
    except ValueError:
        logger.warning("cycle_anchor_unparsed", extra={"cycle": cycle})
        return None


def _recorded_cycle_start(progress: StageProgress, cycle: int) -> datetime | None:
    """Cycle ``cycle``'s retained program start, or None when it is not on record.

    Bounds-checked at both ends: a cycle below 1, a row whose list is absent,
    and a list shorter than ``cycle_number - 1`` (a row the backfill has not
    reached) all return None rather than raising.
    """
    if cycle < _FIRST_CYCLE:
        return None
    anchors = progress.past_cycle_anchors or []
    index = cycle - 1
    if index >= len(anchors):
        return None
    return _parsed_anchor(anchors[index], cycle=cycle)


def _past_cycle_window(progress: StageProgress, cycle: int) -> CycleWindow | None:
    """Build a closed cycle's window, or None when either bound is unknown.

    The end is the successor's start: a retained anchor when the successor is
    itself a past cycle, otherwise the live ``program_started_at``. Both bounds
    are required — a start without an end could window forward past the loop
    and re-serve the NEXT cycle's entries under this cycle's heading, so a
    half-known cycle is reported unknown rather than half-served.
    """
    started_at = _recorded_cycle_start(progress, cycle)
    if started_at is None:
        return None
    successor = cycle + 1
    ended_at = (
        _recorded_cycle_start(progress, successor)
        if successor < progress.cycle_number
        else ensure_aware(resolve_program_anchor(progress))
    )
    if ended_at is None:
        return None
    return CycleWindow(cycle_number=cycle, started_at=started_at, ended_at=ended_at)


def resolve_cycle_window(
    progress: StageProgress | None, cycle: int
) -> tuple[CycleWindow | None, CycleAnchorStatus]:
    """The window cycle ``cycle`` occupied, and why when there is none.

    One call answers both questions on purpose: a caller that asked only "what
    window" would have to invent its own reason for a ``None``, and the four
    causes in :class:`CycleAnchorStatus` are exactly what a reader needs told
    apart. The current cycle comes back open-ended; a past cycle comes back
    closed at its successor's start; anything else comes back as a named
    absence.
    """
    if progress is None:
        return None, CycleAnchorStatus.NO_PROGRAM
    if cycle > progress.cycle_number:
        return None, CycleAnchorStatus.UNSTARTED
    if cycle == progress.cycle_number:
        current = CycleWindow(
            cycle_number=cycle,
            started_at=ensure_aware(resolve_program_anchor(progress)),
            ended_at=None,
        )
        return current, CycleAnchorStatus.RECORDED
    window = _past_cycle_window(progress, cycle)
    if window is None:
        return None, CycleAnchorStatus.UNRECORDED
    return window, CycleAnchorStatus.RECORDED


def cycle_week_bounds(
    window: CycleWindow, weeks: range, *, tz: str | None = None
) -> tuple[datetime, datetime]:
    """The half-open ``[start, end)`` window a span of weeks covers WITHIN one cycle.

    Delegates to :func:`domain.program_calendar.program_week_bounds` so an open
    cycle is windowed byte-for-byte as it always was, then — for a cycle that
    has closed — pulls the end back to the LOCAL MIDNIGHT of the day the loop
    happened. That midnight is the exact instant the successor cycle's week 1
    opens, so the two cycles abut without overlapping and neither bound stops
    being the local midnight the response schema promises.

    ``begin-again`` is permitted the moment the final stage is reached, which
    can be well before 36 calendar weeks have elapsed, so a span the user never
    lived through clamps to an empty ``[x, x)`` rather than reaching forward
    into the next cycle.
    """
    start, end = program_week_bounds(window.started_at, weeks, tz=tz)
    if window.ended_at is None:
        return start, end
    closed_at, _ = day_bounds_in_tz(tz, to_user_date(tz, ensure_aware(window.ended_at)))
    return start, max(start, min(end, closed_at))
