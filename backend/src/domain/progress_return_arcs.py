"""Each Metta Return arc as its own ribbon segment (issue #3745).

The owner's decision on epic #3722: the Return is shown as its own segment, and
a partial one when the arc was not finished. An arc is measured exactly as
``/metta-return`` measures it -- :func:`domain.metta_return.active_return_week`
and :func:`domain.metta_return.is_return_complete` -- with the reference
instant frozen at ``left_at`` once the arc was left. A paused arc is already
frozen at its pause by those helpers, and a resume moves ``started_at`` forward
by the time spent paused, so paused time never counts toward the week reached.

The segment is placed by the recorded pass that was live on the arc's first
day. An arc never opens or closes a pass, so it may overlap the live one.

Pure: the router loads the owner's arcs and passes in one query each.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from domain.dates import ensure_aware, to_user_date
from domain.metta_return import RETURN_WEEK_COUNT, active_return_week, is_return_complete
from schemas.progress import ReturnArcSegment, ReturnArcState

if TYPE_CHECKING:
    from collections.abc import Sequence
    from datetime import date, datetime

    from domain.progress_inputs import OverviewInput
    from models.metta_return_arc import MettaReturnArc
    from models.program_pass import ProgramPass

__all__ = ["return_arcs"]


def _pass_on(day: date, passes: Sequence[ProgramPass]) -> int | None:
    """The number of the recorded pass running on ``day``, or ``None`` outside every pass."""
    for row in passes:
        if row.started_on <= day and (row.ended_on is None or day <= row.ended_on):
            return row.pass_number
    return None


def _state(arc: MettaReturnArc, *, completed: bool) -> ReturnArcState:
    """Left wins; then a lived-through arc is complete even if paused afterwards."""
    if arc.left_at is not None:
        return "left"
    if completed:
        return "complete"
    return "paused" if arc.paused_at is not None else "active"


def _segment(
    arc: MettaReturnArc, passes: Sequence[ProgramPass], timezone: str, now: datetime
) -> ReturnArcSegment:
    """``arc`` measured to its pause, else to when it was left, else to ``now``."""
    reference = arc.left_at if arc.left_at is not None else now
    completed = is_return_complete(arc.started_at, arc.paused_at, reference)
    started_on = to_user_date(timezone, ensure_aware(arc.started_at))
    return ReturnArcSegment(
        started_on=started_on,
        ended_on=None if arc.left_at is None else to_user_date(timezone, ensure_aware(arc.left_at)),
        state=_state(arc, completed=completed),
        weeks_total=RETURN_WEEK_COUNT,
        reached_week=active_return_week(arc.started_at, arc.paused_at, reference),
        completed=completed,
        pass_number=_pass_on(started_on, passes),
    )


def _started(arc: MettaReturnArc) -> tuple[datetime, int]:
    """Oldest first, ties going to the earlier row.

    ``ensure_aware`` because SQLite reads a timezone-aware column back naive.
    """
    return ensure_aware(arc.started_at), arc.id or 0


def return_arcs(data: OverviewInput) -> list[ReturnArcSegment]:
    """Every Return arc oldest first; empty with habits off, as the pass ribbons are."""
    if not data.enable_habits:
        return []
    rows = sorted(data.return_arcs, key=_started)
    return [_segment(arc, data.passes, data.timezone, data.now) for arc in rows]
