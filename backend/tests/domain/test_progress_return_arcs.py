"""Each Metta Return arc is its own ribbon segment (issue #3745).

The arc is measured exactly as ``/metta-return`` measures it: its week comes
from :func:`domain.metta_return.active_return_week` and its completion from
:func:`domain.metta_return.is_return_complete`, frozen at the pause instant
while paused and at ``left_at`` once left. The pass it sits in is the recorded
pass that was live on its first day. An arc never opens or closes a pass, so it
may overlap the live one.
"""

from datetime import UTC, date, datetime, timedelta

import pytest

from domain.metta_return import RETURN_TOTAL_DAYS, RETURN_WEEK_COUNT
from domain.progress_overview import OverviewInput, build_progress_overview
from domain.progress_return_arcs import return_arcs
from models.metta_return_arc import MettaReturnArc
from models.program_pass import PassOrigin, ProgramPass

TODAY = date(2026, 10, 27)
NOW = datetime(2026, 10, 27, 15, 0, tzinfo=UTC)
_DAYS_PER_WEEK = 7


def _at(days_ago: float) -> datetime:
    """The instant ``days_ago`` days before :data:`NOW`."""
    return NOW - timedelta(days=days_ago)


def _arc(
    identifier: int,
    started_days_ago: float,
    *,
    paused_days_ago: float | None = None,
    left_days_ago: float | None = None,
) -> MettaReturnArc:
    """An arc row started, optionally paused and left, that many days before :data:`NOW`."""
    return MettaReturnArc(
        id=identifier,
        user_id=1,
        started_at=_at(started_days_ago),
        paused_at=None if paused_days_ago is None else _at(paused_days_ago),
        left_at=None if left_days_ago is None else _at(left_days_ago),
    )


def _pass(number: int, started_on: date, ended_on: date | None = None) -> ProgramPass:
    """A recorded pass row."""
    return ProgramPass(
        id=number * 100,
        user_id=1,
        pass_number=number,
        started_on=started_on,
        ended_on=ended_on,
        origin=PassOrigin.BEGIN_AGAIN,
    )


def _input(
    *arcs: MettaReturnArc,
    passes: tuple[ProgramPass, ...] = (),
    timezone: str = "UTC",
    enable_habits: bool = True,
) -> OverviewInput:
    """An overview read at :data:`NOW` holding ``arcs`` and ``passes``."""
    return OverviewInput(
        today=TODAY,
        now=NOW,
        timezone=timezone,
        return_arcs=arcs,
        passes=passes,
        enable_habits=enable_habits,
    )


def test_no_arcs_is_an_empty_list() -> None:
    assert return_arcs(_input()) == []


def test_a_completed_arc_reaches_week_five_and_is_complete() -> None:
    """Thirty-five days lived and not left: complete, still open-ended."""
    (arc,) = return_arcs(_input(_arc(1, RETURN_TOTAL_DAYS + 3)))

    assert arc.state == "complete"
    assert arc.completed is True
    assert arc.reached_week == RETURN_WEEK_COUNT
    assert arc.weeks_total == RETURN_WEEK_COUNT
    assert arc.ended_on is None
    assert arc.started_on == TODAY - timedelta(days=RETURN_TOTAL_DAYS + 3)


def test_an_active_arc_reports_the_week_it_sits_in() -> None:
    """Ten days in is week two, still running."""
    (arc,) = return_arcs(_input(_arc(1, 10)))

    assert arc.state == "active"
    assert arc.reached_week == 2  # day ten falls in week two
    assert arc.completed is False
    assert arc.ended_on is None


def test_the_day_before_the_boundary_is_not_complete() -> None:
    """One day short of thirty-five is week five, not yet complete."""
    (arc,) = return_arcs(_input(_arc(1, RETURN_TOTAL_DAYS - 1)))

    assert (arc.state, arc.reached_week, arc.completed) == ("active", RETURN_WEEK_COUNT, False)


def test_a_left_early_arc_is_partial_at_the_week_it_was_left() -> None:
    """Left on day 16 of the arc: week three reached, not complete, ended that day."""
    (arc,) = return_arcs(_input(_arc(1, 40, left_days_ago=24)))

    assert arc.state == "left"
    assert arc.reached_week == 3  # day sixteen falls in week three
    assert arc.completed is False
    assert arc.ended_on == TODAY - timedelta(days=24)


def test_an_arc_left_after_its_five_weeks_is_left_and_completed() -> None:
    """Leaving after the full arc keeps the completion it earned."""
    (arc,) = return_arcs(_input(_arc(1, 60, left_days_ago=10)))

    assert (arc.state, arc.reached_week, arc.completed) == ("left", RETURN_WEEK_COUNT, True)


def test_a_paused_arc_is_frozen_at_the_pause() -> None:
    """Paused on day 9, a month ago: still week two, and time paused is not counted."""
    (arc,) = return_arcs(_input(_arc(1, 40, paused_days_ago=31)))

    assert arc.state == "paused"
    assert arc.reached_week == 2  # frozen on day nine
    assert arc.completed is False
    assert arc.ended_on is None


def test_an_arc_left_while_paused_reports_the_week_it_was_paused_in() -> None:
    """Paused on day 3, left three weeks later: week one, the pause excluded."""
    (arc,) = return_arcs(_input(_arc(1, 30, paused_days_ago=27, left_days_ago=6)))

    assert (arc.state, arc.reached_week, arc.completed) == ("left", 1, False)
    assert arc.ended_on == TODAY - timedelta(days=6)


def test_a_paused_arc_past_its_five_weeks_is_complete() -> None:
    """Completion wins over the pause once all thirty-five days were lived."""
    (arc,) = return_arcs(_input(_arc(1, 50, paused_days_ago=5)))

    assert (arc.state, arc.reached_week, arc.completed) == ("complete", RETURN_WEEK_COUNT, True)


def test_arcs_are_served_oldest_first() -> None:
    """Whatever order the rows arrive in, the earliest start comes first."""
    later = _arc(2, 5)
    earlier = _arc(1, 90, left_days_ago=80)

    served = return_arcs(_input(later, earlier))

    assert [arc.started_on for arc in served] == [
        TODAY - timedelta(days=90),
        TODAY - timedelta(days=5),
    ]


def test_each_arc_names_the_pass_live_on_its_first_day() -> None:
    """Arcs in an ended pass, the live pass, and before any pass are each placed."""
    first = _pass(1, date(2026, 1, 5), date(2026, 8, 31))
    second = _pass(2, date(2026, 9, 1))
    arcs = (
        _arc(1, (TODAY - date(2025, 12, 1)).days, left_days_ago=300),
        _arc(2, (TODAY - date(2026, 8, 31)).days, left_days_ago=40),
        _arc(3, (TODAY - date(2026, 9, 1)).days, left_days_ago=20),
        _arc(4, 3),
    )

    served = return_arcs(_input(*arcs, passes=(second, first)))

    assert [arc.pass_number for arc in served] == [None, 1, 2, 2]


def test_a_gap_between_recorded_passes_places_no_pass() -> None:
    """A day no recorded pass covers names no pass rather than a guess."""
    first = _pass(1, date(2026, 1, 5), date(2026, 3, 1))
    third = _pass(3, date(2026, 9, 1))
    arc_day = date(2026, 5, 1)

    (arc,) = return_arcs(
        _input(_arc(1, (TODAY - arc_day).days, left_days_ago=100), passes=(first, third))
    )

    assert arc.pass_number is None


def test_a_not_yet_begun_pass_does_not_claim_an_earlier_arc() -> None:
    """A pass that starts after the arc began is not the arc's pass."""
    future = _pass(1, TODAY + timedelta(days=9))

    (arc,) = return_arcs(_input(_arc(1, 2), passes=(future,)))

    assert arc.pass_number is None


def test_the_start_day_is_the_account_zone_day() -> None:
    """At UTC+14 an arc begun at 15:00 UTC started on the next local day."""
    (arc,) = return_arcs(_input(_arc(1, 0), timezone="Pacific/Kiritimati"))

    assert arc.started_on == TODAY + timedelta(days=1)


def test_a_naive_stored_instant_is_read_as_utc() -> None:
    """SQLite reads the aware column back naive; the arc is still measured."""
    row = _arc(1, 10, left_days_ago=2)
    row.started_at = row.started_at.replace(tzinfo=None)
    assert row.left_at is not None
    row.left_at = row.left_at.replace(tzinfo=None)

    (arc,) = return_arcs(_input(row))

    assert (arc.started_on, arc.ended_on, arc.reached_week) == (
        TODAY - timedelta(days=10),
        TODAY - timedelta(days=2),
        2,
    )


def test_habits_off_serves_no_return_arcs() -> None:
    """The segments ride the pass ribbons, which a declined habits ring hides."""
    assert return_arcs(_input(_arc(1, 10), enable_habits=False)) == []


@pytest.mark.parametrize("enable_habits", [True, False])
def test_the_overview_arc_carries_the_return_arcs(enable_habits: bool) -> None:
    """``arc.return_arcs`` is the builder's list, beside the passes."""
    data = _input(
        _arc(1, 10), passes=(_pass(1, TODAY - timedelta(days=50)),), enable_habits=enable_habits
    )

    served = build_progress_overview(data).arc.return_arcs

    assert served == return_arcs(data)
    assert len(served) == (1 if enable_habits else 0)
