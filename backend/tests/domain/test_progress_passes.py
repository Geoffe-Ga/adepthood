"""One ribbon per recorded pass, built from stored rows only (issue #3726).

Each pass is measured from its OWN ``started_on``: its markers sit in that
pass's weeks, and a closed pass reports what ``close_pass`` recorded. Nothing
here reads the live anchor for an earlier pass, so moving it cannot move them.
"""

from dataclasses import replace
from datetime import UTC, date, datetime, timedelta

import pytest

from domain.constants import STAGE_DURATIONS_DAYS
from domain.program_pass import PROGRAM_CALENDAR, close_pass
from domain.progress_overview import OverviewInput, build_progress_overview
from domain.progress_passes import arc_passes
from models.habit import Habit
from models.habit_unlock_event import HabitUnlockEvent, UnlockKind, UnlockSource
from models.program_pass import PassOrigin, ProgramPass
from models.stage_progress import StageProgress

FIRST = date(2026, 1, 5)
SECOND = date(2026, 6, 1)
THIRD = date(2026, 9, 7)
TODAY = date(2026, 10, 27)
_DAYS_PER_WEEK = 7


def _habit(identifier: int, *, revealed: bool = True) -> Habit:
    """An owner habit with a recognisable name and icon."""
    return Habit(
        id=identifier,
        user_id=1,
        name=f"Habit {identifier}",
        icon=f"icon-{identifier}",
        start_date=FIRST,
        stage="Beige",
        energy_cost=1,
        energy_return=2,
        revealed=revealed,
    )


def _pass(
    identifier: int,
    started_on: date,
    *,
    ended_on: date | None = None,
    reached: tuple[int, int, bool] | None = None,
    origin: PassOrigin = PassOrigin.BEGIN_AGAIN,
) -> ProgramPass:
    """A stored pass row; ``reached`` is ``(stage, week, completed)`` for a closed one."""
    return ProgramPass(
        id=identifier * 100,
        user_id=1,
        pass_number=identifier,
        started_on=started_on,
        ended_on=ended_on,
        origin=origin,
        reached_stage=reached[0] if reached else None,
        reached_week=reached[1] if reached else None,
        completed=reached[2] if reached else False,
    )


_event_ids = iter(range(1, 10_000))


def _event(
    habit_id: int,
    pass_: ProgramPass | None,
    day: date,
    *,
    number: int,
    kind: UnlockKind = UnlockKind.UNLOCKED,
) -> HabitUnlockEvent:
    """One log row on ``day`` in ``pass_`` at program number ``number``."""
    return HabitUnlockEvent(
        id=next(_event_ids),
        user_id=1,
        habit_id=habit_id,
        pass_id=None if pass_ is None else pass_.id,
        kind=kind,
        occurred_at=datetime(day.year, day.month, day.day, 12, tzinfo=UTC),
        local_day=day,
        program_number=number,
        source=UnlockSource.MANUAL,
    )


def _three_passes() -> tuple[ProgramPass, ProgramPass, ProgramPass]:
    """Pass 1 ended partial, pass 2 ended complete (a back-dated save), pass 3 live."""
    return (
        _pass(1, FIRST, ended_on=SECOND - timedelta(days=1), reached=(7, 21, False)),
        _pass(
            2,
            SECOND - timedelta(days=300),
            ended_on=THIRD - timedelta(days=1),
            reached=(10, 36, True),
            origin=PassOrigin.RESCAFFOLD,
        ),
        _pass(3, THIRD, origin=PassOrigin.BEGIN_AGAIN),
    )


def _input(
    passes: list[ProgramPass],
    events: list[HabitUnlockEvent],
    habits: list[Habit] | None = None,
    *,
    pending: date | None = None,
) -> OverviewInput:
    """An overview whose live anchor is the last pass's start."""
    live_start = passes[-1].started_on if passes else FIRST
    return OverviewInput(
        today=TODAY,
        timezone="UTC",
        progress=StageProgress(
            user_id=1,
            current_stage=1,
            cycle_number=max((row.pass_number for row in passes), default=1),
            program_started_at=datetime(
                live_start.year, live_start.month, live_start.day, tzinfo=UTC
            ),
            pending_pass_starts_on=pending,
        ),
        habits=habits if habits is not None else [_habit(1), _habit(2), _habit(3)],
        passes=passes,
        unlock_events=events,
        enable_practices=False,
    )


def _at_cycle(progress: StageProgress | None, cycle: int) -> StageProgress:
    """``progress`` at cycle ``cycle``."""
    assert progress is not None
    progress.cycle_number = cycle
    return progress


def _week_of(day: date, start: date) -> int:
    """The 1-based week ``day`` falls in for a pass begun ``start``."""
    return (day - start).days // _DAYS_PER_WEEK + 1


def test_three_passes_are_oldest_first_with_their_own_dates_and_extent() -> None:
    """Ended-partial, ended-complete and live, each from its stored row."""
    first, second, third = _three_passes()
    result = arc_passes(_input([third, first, second], []))
    assert [row.pass_number for row in result] == [1, 2, 3]
    assert [row.state for row in result] == ["ended", "ended", "live"]
    assert [row.origin for row in result] == ["begin_again", "rescaffold", "begin_again"]
    assert result[0].started_on == FIRST
    assert result[0].ended_on == SECOND - timedelta(days=1)
    assert (result[0].reached_stage, result[0].reached_week, result[0].completed) == (7, 21, False)
    assert (result[1].reached_stage, result[1].reached_week, result[1].completed) == (10, 36, True)
    live = result[2]
    assert live.ended_on is None
    assert live.reached_week == _week_of(TODAY, THIRD)
    assert live.reached_stage == 3  # week 8 sits in stage 3's block
    assert live.completed is False
    assert all(row.days_until_start == 0 for row in result)


def test_markers_sit_in_each_passs_own_weeks() -> None:
    """The same habit marks every pass it was unlocked in, measured from that pass."""
    first, second, third = _three_passes()
    unlocked_first = FIRST + timedelta(days=20)
    unlocked_third = THIRD + timedelta(days=50)
    events = [
        _event(1, first, unlocked_first, number=1),
        _event(2, first, FIRST, number=2),
        _event(1, third, unlocked_third, number=5),
    ]
    result = arc_passes(_input([first, second, third], events))
    assert [(m.habit_id, m.week, m.program_number) for m in result[0].markers] == [
        (2, 1, 2),
        (1, _week_of(unlocked_first, FIRST), 1),
    ]
    assert result[1].markers == []
    (marker,) = result[2].markers
    assert marker.habit_id == 1
    assert marker.name == "Habit 1"
    assert marker.icon == "icon-1"
    assert marker.program_number == 5  # the number stored on the event
    assert marker.week == _week_of(unlocked_third, THIRD)
    assert marker.unlocked_on == unlocked_third
    assert marker.currently_locked is False


def test_unlock_relock_unlock_marks_the_last_unlock_at_its_own_number() -> None:
    """The most recent unlock wins, carrying the number it was written with."""
    *_, live = _three_passes()
    last = THIRD + timedelta(days=30)
    events = [
        _event(1, live, THIRD, number=1),
        _event(1, live, THIRD + timedelta(days=10), number=1, kind=UnlockKind.RELOCKED),
        _event(1, live, last, number=4),
    ]
    (row,) = arc_passes(_input([live], events))
    (marker,) = row.markers
    assert (marker.unlocked_on, marker.program_number) == (last, 4)
    assert marker.week == _week_of(last, THIRD)
    assert marker.currently_locked is False


def test_a_relocked_habit_is_currently_locked() -> None:
    """A re-lock after the last unlock keeps the marker, drawn as locked."""
    *_, live = _three_passes()
    events = [
        _event(1, live, THIRD, number=1),
        _event(1, live, THIRD + timedelta(days=3), number=1, kind=UnlockKind.RELOCKED),
    ]
    (row,) = arc_passes(_input([live], events))
    (marker,) = row.markers
    assert marker.unlocked_on == THIRD
    assert marker.currently_locked is True


def test_a_habit_locked_now_is_currently_locked_even_without_a_relock_event() -> None:
    """The habit's present lock state also counts, so the two never disagree."""
    *_, live = _three_passes()
    events = [_event(1, live, THIRD, number=1)]
    (row,) = arc_passes(_input([live], events, [_habit(1, revealed=False)]))
    assert row.markers[0].currently_locked is True


def test_a_relock_in_a_later_pass_does_not_lock_an_earlier_passs_marker() -> None:
    """Lock state is read per pass: pass 1's unlock stands while the habit is open."""
    first, _, third = _three_passes()
    events = [
        _event(1, first, FIRST, number=1),
        _event(1, third, THIRD, number=1, kind=UnlockKind.RELOCKED),
    ]
    result = arc_passes(_input([first, third], events))
    assert result[0].markers[0].currently_locked is False
    assert result[1].markers == []


def test_never_unlocked_unknown_and_passless_events_make_no_marker() -> None:
    """Only an unlock tagged with the pass, on a habit still owned, is drawn."""
    *_, live = _three_passes()
    events = [
        _event(1, live, THIRD, number=1, kind=UnlockKind.RELOCKED),
        _event(2, None, THIRD, number=2),
        _event(99, live, THIRD, number=3),
    ]
    (row,) = arc_passes(_input([live], events))
    assert row.markers == []


def test_a_late_unlock_in_a_live_pass_stays_on_the_last_week() -> None:
    """A live pass run past the program's end keeps its markers on the ribbon."""
    live = _pass(1, FIRST)
    late = FIRST + timedelta(days=400)
    data = replace(_input([live], [_event(1, live, late, number=1)]), today=late)
    (row,) = arc_passes(data)
    assert row.markers[0].week == 36  # the ribbon's last week
    assert (row.reached_stage, row.reached_week, row.completed) == (10, 36, True)


def test_a_pending_pass_is_drawn_after_the_live_one_with_its_countdown() -> None:
    """A saved future start appears as a pending row with no markers."""
    first, _, third = _three_passes()
    begins = TODAY + timedelta(days=12)
    events = [_event(1, third, THIRD, number=1)]
    result = arc_passes(_input([first, third], events, pending=begins))
    assert [row.state for row in result] == ["ended", "live", "pending"]
    pending = result[-1]
    assert pending.pass_number == 4  # the number the pass will be recorded with
    assert pending.started_on == begins
    assert pending.ended_on is None
    assert pending.origin == "rescaffold"
    assert pending.days_until_start == 12  # twelve days ahead
    assert (pending.reached_stage, pending.reached_week, pending.completed) == (None, None, False)
    assert pending.markers == []
    assert result[1].markers != []


def test_a_pending_pass_with_no_live_row_numbers_past_the_backfill() -> None:
    """Mirror ``open_next_pass``: the unrecorded live pass takes the cycle's number first."""
    first = _pass(1, FIRST, ended_on=SECOND - timedelta(days=1), reached=(7, 21, False))
    data = _input([first], [], pending=TODAY + timedelta(days=1))
    data = replace(data, progress=_at_cycle(data.progress, 3))
    result = arc_passes(data)
    assert [row.pass_number for row in result] == [1, 4]


def test_an_arrived_pending_day_left_unsettled_draws_no_pending_row() -> None:
    """The router settles first; an unsettled arrived day is never shown as ahead."""
    *_, live = _three_passes()
    result = arc_passes(_input([live], [], pending=TODAY))
    assert [row.state for row in result] == ["live"]


def test_a_first_pass_starting_in_the_future_is_pending() -> None:
    """A recorded pass that has not begun counts down and carries no markers."""
    ahead = _pass(1, TODAY + timedelta(days=5), origin=PassOrigin.FIRST_RUN)
    events = [_event(1, ahead, TODAY, number=1)]
    (row,) = arc_passes(_input([ahead], events))
    assert row.state == "pending"
    assert row.days_until_start == 5  # five days ahead
    assert (row.reached_stage, row.reached_week) == (None, None)
    assert row.markers == []


def test_habits_off_hides_every_pass() -> None:
    """Matching the births: the habits ring declined means no ribbons at all."""
    first, second, third = _three_passes()
    data = replace(
        _input(
            [first, second, third],
            [_event(1, third, THIRD, number=1)],
            pending=TODAY + timedelta(days=3),
        ),
        enable_habits=False,
    )
    assert arc_passes(data) == []


def test_no_progress_row_and_no_passes_is_empty() -> None:
    """An unstarted account has no pass to draw, pending or otherwise."""
    assert arc_passes(replace(_input([], []), progress=None)) == []


def test_moving_the_live_anchor_leaves_earlier_passes_unchanged() -> None:
    """Earlier rows are byte-identical after the live pass and anchor move."""
    first, second, third = _three_passes()
    events = [_event(1, first, FIRST + timedelta(days=9), number=1)]
    before = build_progress_overview(_input([first, second, third], events))
    moved = _pass(3, THIRD + timedelta(days=21))
    after = build_progress_overview(_input([first, second, moved], events))
    assert [row.model_dump_json() for row in before.arc.passes[:2]] == [
        row.model_dump_json() for row in after.arc.passes[:2]
    ]
    assert before.arc.passes[2] != after.arc.passes[2]


def test_existing_arc_fields_are_untouched_by_passes() -> None:
    """The shipped single ribbon reads exactly what it read before."""
    first, second, third = _three_passes()
    with_passes = _input([first, second, third], [_event(1, third, THIRD, number=1)])
    without = replace(with_passes, passes=(), unlock_events=())
    shipped = build_progress_overview(without).arc.model_dump(exclude={"passes"})
    assert build_progress_overview(with_passes).arc.model_dump(exclude={"passes"}) == shipped
    assert build_progress_overview(without).arc.passes == []


def test_an_ended_pass_ignores_the_habits_lock_today() -> None:
    """Unlocked in pass 1 and locked now: pass 1 ended with it open, so it is not locked there."""
    first, _, third = _three_passes()
    events = [_event(1, first, FIRST, number=1)]
    result = arc_passes(_input([first, third], events, [_habit(1, revealed=False)]))
    assert result[0].markers[0].currently_locked is False


def test_an_ended_pass_keeps_a_relock_at_its_end_after_a_later_reopen() -> None:
    """Re-locked at the end of pass 1 and reopened in pass 3: still locked on pass 1."""
    first, _, third = _three_passes()
    events = [
        _event(1, first, FIRST, number=1),
        _event(1, first, SECOND - timedelta(days=2), number=1, kind=UnlockKind.RELOCKED),
        _event(1, third, THIRD + timedelta(days=4), number=1),
    ]
    result = arc_passes(_input([first, third], events))
    assert result[0].markers[0].currently_locked is True
    assert result[1].markers[0].currently_locked is False


def test_a_future_first_pass_and_a_held_save_draw_one_pending_entry() -> None:
    """Never two pending rows: the pass that starts first is the one shown as ahead."""
    ahead = _pass(1, TODAY + timedelta(days=5), origin=PassOrigin.FIRST_RUN)
    result = arc_passes(_input([ahead], [], pending=TODAY + timedelta(days=40)))
    assert [(row.pass_number, row.state) for row in result] == [(1, "pending")]
    assert result[0].started_on == TODAY + timedelta(days=5)


@pytest.mark.parametrize(
    "elapsed",
    [
        0,
        STAGE_DURATIONS_DAYS[0],
        PROGRAM_CALENDAR.total_days - 1,
        PROGRAM_CALENDAR.total_days,
    ],
)
def test_a_live_pass_reaches_what_closing_it_today_would_record(elapsed: int) -> None:
    """Live ``reached_*`` and ``completed`` match ``close_pass(ended_on=today)`` exactly."""
    started_on = TODAY - timedelta(days=elapsed)
    (row,) = arc_passes(_input([_pass(1, started_on)], []))
    closed = close_pass(_pass(1, started_on), ended_on=TODAY, calendar=PROGRAM_CALENDAR)
    assert (row.reached_stage, row.reached_week, row.completed) == (
        closed.reached_stage,
        closed.reached_week,
        closed.completed,
    )
