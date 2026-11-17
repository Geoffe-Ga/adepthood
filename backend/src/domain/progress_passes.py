"""One ribbon per pass through the stages, from stored rows only (issue #3726).

The shipped single ribbon (:mod:`domain.progress_overview`'s habit births) is
measured from the LIVE anchor, so moving that anchor moved every earlier
marker. Here each pass is measured from its OWN ``started_on``: a closed pass
reports what :func:`domain.program_pass.close_pass` recorded, and its markers
come from the unlock log rows tagged with it. Nothing about an earlier pass
reads the live anchor, so re-anchoring the live pass cannot change one.

A marker is a habit's most recent unlock in the pass, at the program number
stored on that event (epic #3722, decision 3). A habit never unlocked in a pass
has no marker there, and a log row with no pass is never drawn. How far a pass
got is display only (decision 4): Course completions are not consulted.

Pure: the router loads the owner's passes and their events in one query each.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from typing import TYPE_CHECKING, cast

from domain.habit_unlock_log import latest_events, latest_unlocks
from domain.program_pass import PROGRAM_CALENDAR
from models.habit_unlock_event import UnlockKind
from models.program_pass import PassOrigin
from schemas.progress import ArcPass, PassMarker, PassState

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from domain.progress_inputs import OverviewInput
    from models.habit import Habit
    from models.habit_unlock_event import HabitUnlockEvent
    from models.program_pass import ProgramPass

__all__ = ["arc_passes"]


def _state(row: ProgramPass, today: date) -> PassState:
    """Closed rows are ended; an open row is pending until its first day."""
    if row.ended_on is not None:
        return "ended"
    return "pending" if row.started_on > today else "live"


def _not_begun(number: int, started_on: date, origin: PassOrigin, today: date) -> ArcPass:
    """A pass whose first day is still ahead: a countdown, nothing reached, no markers."""
    return ArcPass(
        pass_number=number,
        started_on=started_on,
        ended_on=None,
        origin=origin,
        state="pending",
        days_until_start=(started_on - today).days,
        reached_stage=None,
        reached_week=None,
        completed=False,
        markers=[],
    )


def _marker(
    row: ProgramPass, unlock: HabitUnlockEvent, habit: Habit, last: HabitUnlockEvent
) -> PassMarker:
    """``habit``'s marker at ``unlock``, placed in ``row``'s own weeks.

    Locked means "locked at the pass's end" for an ended pass -- its last event
    on the habit is a re-lock -- and the present state for the live pass,
    which also counts a habit that is locked now.
    """
    elapsed = max(0, (unlock.local_day - row.started_on).days)
    locked_now = row.ended_on is None and not habit.revealed
    return PassMarker(
        habit_id=unlock.habit_id,
        name=habit.name,
        icon=habit.icon,
        program_number=unlock.program_number,
        week=PROGRAM_CALENDAR.week_on(elapsed),
        unlocked_on=unlock.local_day,
        currently_locked=last.kind == UnlockKind.RELOCKED or locked_now,
    )


def _markers(
    row: ProgramPass, events: Sequence[HabitUnlockEvent], habits: Mapping[int, Habit]
) -> list[PassMarker]:
    """One marker per still-owned habit unlocked in ``row``, by week then number."""
    pass_id = cast("int", row.id)
    last = latest_events(events, pass_id)
    markers = [
        _marker(row, unlock, habits[habit_id], last[habit_id])
        for habit_id, unlock in latest_unlocks(events, pass_id).items()
        if habit_id in habits
    ]
    return sorted(markers, key=lambda marker: (marker.week, marker.program_number, marker.habit_id))


def _reach(row: ProgramPass, state: PassState, today: date) -> tuple[int | None, int | None, bool]:
    """``(stage, week, completed)``: as recorded when ended, as if closed today when live."""
    if state == "ended":
        return row.reached_stage, row.reached_week, row.completed
    elapsed = (today - row.started_on).days
    return (
        PROGRAM_CALENDAR.stage_on(elapsed),
        PROGRAM_CALENDAR.week_on(elapsed),
        elapsed >= PROGRAM_CALENDAR.total_days - 1,
    )


def _recorded(
    row: ProgramPass,
    events: Sequence[HabitUnlockEvent],
    habits: Mapping[int, Habit],
    today: date,
) -> ArcPass:
    """A stored pass as drawn today; a live one is measured as if it closed today."""
    state = _state(row, today)
    origin = PassOrigin(row.origin)
    if state == "pending":
        return _not_begun(row.pass_number, row.started_on, origin, today)
    stage, week, completed = _reach(row, state, today)
    return ArcPass(
        pass_number=row.pass_number,
        started_on=row.started_on,
        ended_on=row.ended_on,
        origin=origin,
        state=state,
        days_until_start=0,
        reached_stage=stage,
        reached_week=week,
        completed=completed,
        markers=_markers(row, events, habits),
    )


def _pending_day(data: OverviewInput) -> date | None:
    """The held start day, if one is saved and still ahead of today.

    A day already come is the router's to settle first, so it is never drawn
    as still ahead.
    """
    starts_on = data.progress.pending_pass_starts_on if data.progress is not None else None
    return starts_on if starts_on is not None and starts_on > data.today else None


def _pending_number(cycle_number: int, rows: Sequence[ProgramPass]) -> int:
    """The number the held pass will be recorded with, mirroring ``open_next_pass``.

    One past the highest recorded pass, or, when the running pass was never
    recorded, one past the number that pass will be backfilled with.
    """
    highest = max((row.pass_number for row in rows), default=0)
    if all(row.ended_on is not None for row in rows):
        highest = max(cycle_number, highest + 1)
    return highest + 1


def _any_not_begun(rows: Sequence[ProgramPass], today: date) -> bool:
    """Whether a recorded pass is itself still ahead (a first-cycle future start)."""
    return any(_state(row, today) == "pending" for row in rows)


def _pending(data: OverviewInput, rows: Sequence[ProgramPass]) -> ArcPass | None:
    """The pass a future scaffolding save is holding; it has no row until its day.

    See :mod:`domain.pass_rescaffold`. At most one entry is ever pending: when
    a recorded pass has not begun either, that one starts first and is the
    entry drawn as ahead; the held save behind it is not drawn until it opens.
    """
    starts_on = _pending_day(data)
    if starts_on is None or data.progress is None or _any_not_begun(rows, data.today):
        return None
    number = _pending_number(data.progress.cycle_number, rows)
    return _not_begun(number, starts_on, PassOrigin.RESCAFFOLD, data.today)


def _events_by_pass(
    events: Sequence[HabitUnlockEvent],
) -> defaultdict[int | None, list[HabitUnlockEvent]]:
    """The log rows grouped by the pass they were written in."""
    grouped: defaultdict[int | None, list[HabitUnlockEvent]] = defaultdict(list)
    for event in events:
        grouped[event.pass_id].append(event)
    return grouped


def arc_passes(data: OverviewInput) -> list[ArcPass]:
    """Every recorded pass oldest first, then any pending one; empty with habits off."""
    if not data.enable_habits:
        return []
    habits = {cast("int", habit.id): habit for habit in data.habits}
    by_pass = _events_by_pass(data.unlock_events)
    rows = sorted(data.passes, key=lambda row: row.pass_number)
    drawn = [_recorded(row, by_pass[row.id], habits, data.today) for row in rows]
    pending = _pending(data, rows)
    return drawn if pending is None else [*drawn, pending]
