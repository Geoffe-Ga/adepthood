import pytest

from domain.streaks import is_scheduled_on, update_streak


def test_streak_increment() -> None:
    new_streak, code = update_streak(3, did_check_in=True)
    assert new_streak == 4
    assert code == "streak_incremented"


def test_streak_reset() -> None:
    new_streak, code = update_streak(5, did_check_in=False)
    assert new_streak == 0
    assert code == "streak_reset"


def test_streak_held_when_not_scheduled() -> None:
    """A miss on a non-scheduled day holds the streak."""
    new_streak, code = update_streak(5, did_check_in=False, is_scheduled_today=False)
    assert new_streak == 5
    assert code == "streak_held"


def test_streak_increments_on_unscheduled_day_when_user_checks_in() -> None:
    """An opportunistic check-in on a non-scheduled day still increments."""
    new_streak, code = update_streak(2, did_check_in=True, is_scheduled_today=False)
    assert new_streak == 3
    assert code == "streak_incremented"


def test_is_scheduled_on_none_means_every_day() -> None:
    assert is_scheduled_on(None, "Tue") is True


def test_is_scheduled_on_empty_means_every_day() -> None:
    assert is_scheduled_on([], "Tue") is True


def test_is_scheduled_on_match() -> None:
    assert is_scheduled_on(["Mon", "Wed", "Fri"], "Wed") is True


def test_is_scheduled_on_miss() -> None:
    assert is_scheduled_on(["Mon", "Wed", "Fri"], "Tue") is False


def test_is_scheduled_on_case_insensitive() -> None:
    assert is_scheduled_on(["mon", "wed"], "Mon") is True


@pytest.mark.parametrize("bad_name", ["monday", "MO", "", "tues", "Mond"])
def test_is_scheduled_on_rejects_invalid_weekday(bad_name: str) -> None:
    """A misspelled weekday raises rather than silently returning False."""
    with pytest.raises(ValueError, match="weekday_name must be one of"):
        is_scheduled_on(["Mon"], bad_name)
