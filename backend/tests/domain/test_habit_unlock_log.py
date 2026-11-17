"""``latest_unlocks`` reads the most recent unlock of each habit in one pass (issue #3724).

The ribbon marks a habit where it was most recently unlocked in a pass, so the
answer is the latest ``unlocked`` event -- even when a later ``relocked`` event
follows it, because the marker is "the most recent unlock date available".
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from domain.habit_unlock_log import latest_unlocks
from models.habit_unlock_event import HabitUnlockEvent, UnlockKind, UnlockSource

_PASS = 2
_OTHER_PASS = 1
_HABIT = 12
_OTHER_HABIT = 13
_DAY_ONE = datetime(2026, 6, 22, 9, tzinfo=UTC)


def _event(event_id: int, **fields: object) -> HabitUnlockEvent:
    """One logged lock-state change: a manual unlock of habit 12 in pass 2 unless overridden."""
    values: dict[str, object] = {
        "id": event_id,
        "user_id": 1,
        "habit_id": _HABIT,
        "pass_id": _PASS,
        "kind": UnlockKind.UNLOCKED,
        "occurred_at": _DAY_ONE,
        "program_number": 3,
        "source": UnlockSource.MANUAL,
    }
    values.update(fields)
    at = values["occurred_at"]
    assert isinstance(at, datetime)
    return HabitUnlockEvent.model_validate({**values, "local_day": at.date()})


def test_the_issue_example_marks_the_third_event() -> None:
    """Unlock, re-lock, unlock again after a move: the marker is the last unlock, at 5."""
    first = _event(1, source=UnlockSource.AUTO_REVEAL)
    relock = _event(2, kind=UnlockKind.RELOCKED, occurred_at=datetime(2026, 7, 1, tzinfo=UTC))
    again = _event(3, occurred_at=datetime(2026, 7, 20, tzinfo=UTC), program_number=5)

    latest = latest_unlocks([first, relock, again], _PASS)

    assert latest == {_HABIT: again}
    assert latest[_HABIT].program_number == 5
    assert latest[_HABIT].local_day == date(2026, 7, 20)


def test_a_habit_relocked_last_still_reports_its_latest_unlock() -> None:
    """A trailing re-lock does not erase the unlock before it."""
    unlock = _event(1)
    relock = _event(2, kind=UnlockKind.RELOCKED, occurred_at=_DAY_ONE + timedelta(days=3))

    assert latest_unlocks([unlock, relock], _PASS) == {_HABIT: unlock}


def test_a_habit_only_ever_relocked_in_the_pass_has_no_marker() -> None:
    """Re-locks alone never produce a marker."""
    relock = _event(1, kind=UnlockKind.RELOCKED)

    assert latest_unlocks([relock], _PASS) == {}


def test_events_from_another_pass_are_ignored() -> None:
    """A later unlock in a different pass does not move this pass's marker."""
    here = _event(1)
    elsewhere = _event(2, occurred_at=_DAY_ONE + timedelta(days=90), pass_id=_OTHER_PASS)
    unknown = _event(3, occurred_at=_DAY_ONE + timedelta(days=91), pass_id=None)

    assert latest_unlocks([here, elsewhere, unknown], _PASS) == {_HABIT: here}


def test_order_of_input_does_not_matter() -> None:
    """The latest by ``occurred_at`` wins however the events arrive."""
    early = _event(1)
    late = _event(2, occurred_at=_DAY_ONE + timedelta(days=5))

    assert latest_unlocks([late, early], _PASS) == {_HABIT: late}


def test_a_tie_in_time_goes_to_the_later_write() -> None:
    """Two unlocks stamped the same instant resolve to the one written last."""
    first = _event(1)
    second = _event(2)

    assert latest_unlocks([second, first], _PASS) == {_HABIT: second}


def test_each_habit_gets_its_own_marker() -> None:
    """The result is keyed by habit."""
    mine = _event(1)
    theirs = _event(2, habit_id=_OTHER_HABIT, program_number=4)

    assert latest_unlocks([mine, theirs], _PASS) == {_HABIT: mine, _OTHER_HABIT: theirs}


def test_no_events_means_no_markers() -> None:
    """An empty log is an empty answer, not an error."""
    assert latest_unlocks([], _PASS) == {}


def test_a_naive_instant_read_back_from_sqlite_compares_as_utc() -> None:
    """SQLite drops the zone on read; such a row still orders against an aware one."""
    naive_next_day = (_DAY_ONE + timedelta(days=1)).replace(tzinfo=None)
    stored = _event(1, occurred_at=naive_next_day)
    fresh = _event(2)

    assert latest_unlocks([stored, fresh], _PASS) == {_HABIT: stored}
