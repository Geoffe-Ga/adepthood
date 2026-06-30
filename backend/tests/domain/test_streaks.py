from datetime import date, timedelta

import pytest

from domain.streaks import current_consecutive_streak, is_scheduled_on

_TODAY = date(2026, 6, 30)
_YESTERDAY = _TODAY - timedelta(days=1)


def test_current_consecutive_streak_empty_is_zero() -> None:
    assert current_consecutive_streak([], _TODAY) == 0


def test_current_consecutive_streak_today_counts() -> None:
    """A completion today grace-gates open and starts the chain at 1."""
    assert current_consecutive_streak([_TODAY], _TODAY) == 1


def test_current_consecutive_streak_yesterday_grace_window() -> None:
    """Most-recent day == yesterday is still inside the one-day grace gate."""
    assert current_consecutive_streak([_YESTERDAY], _TODAY) == 1


def test_current_consecutive_streak_two_days_stale_breaks() -> None:
    """Most-recent day older than yesterday is stale; the streak is 0."""
    two_days_ago = _TODAY - timedelta(days=2)
    assert current_consecutive_streak([two_days_ago], _TODAY) == 0


def test_current_consecutive_streak_counts_consecutive_run() -> None:
    days_desc = [_TODAY - timedelta(days=i) for i in range(3)]
    assert current_consecutive_streak(days_desc, _TODAY) == 3


def test_current_consecutive_streak_gap_breaks_chain() -> None:
    """A gap > 1 day ends the walk; only the leading run counts."""
    days_desc = [_TODAY, _YESTERDAY, _TODAY - timedelta(days=3)]
    assert current_consecutive_streak(days_desc, _TODAY) == 2


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
