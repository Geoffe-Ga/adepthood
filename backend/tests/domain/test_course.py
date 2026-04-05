"""Unit tests for course domain logic — drip-feed gating and progress calculation."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from domain.course import compute_days_elapsed, filter_content_for_user, next_unlock_day

_EXPECTED_THREE = 3
_EXPECTED_TWO = 2
_EXPECTED_FIVE = 5


class TestComputeDaysElapsed:
    def test_zero_days(self) -> None:
        now = datetime.now(UTC)
        assert compute_days_elapsed(now) == 0

    def test_three_days(self) -> None:
        three_days_ago = datetime.now(UTC) - timedelta(days=3)
        assert compute_days_elapsed(three_days_ago) == _EXPECTED_THREE

    def test_partial_day_rounds_down(self) -> None:
        almost_two_days = datetime.now(UTC) - timedelta(days=1, hours=23)
        assert compute_days_elapsed(almost_two_days) == 1


class TestFilterContentForUser:
    """Test the pure content-filtering logic."""

    def test_day_zero_filters_locked_items(self) -> None:
        items = [
            {"release_day": 0, "url": "https://a.com"},
            {"release_day": 3, "url": "https://b.com"},
            {"release_day": 7, "url": "https://c.com"},
        ]
        result = filter_content_for_user(items, days_elapsed=0, read_content_ids=set())
        unlocked = [r for r in result if not r["is_locked"]]
        locked = [r for r in result if r["is_locked"]]
        assert len(unlocked) == 1
        assert len(locked) == _EXPECTED_TWO
        # Locked items should have no URL
        for item in locked:
            assert item["url"] is None

    def test_all_unlocked_after_enough_days(self) -> None:
        items = [
            {"release_day": 0, "url": "https://a.com"},
            {"release_day": 3, "url": "https://b.com"},
            {"release_day": 7, "url": "https://c.com"},
        ]
        result = filter_content_for_user(items, days_elapsed=10, read_content_ids=set())
        assert all(not r["is_locked"] for r in result)

    def test_read_items_marked(self) -> None:
        items = [
            {"id": 1, "release_day": 0, "url": "https://a.com"},
            {"id": 2, "release_day": 0, "url": "https://b.com"},
        ]
        result = filter_content_for_user(items, days_elapsed=0, read_content_ids={1})
        assert result[0]["is_read"] is True
        assert result[1]["is_read"] is False


class TestNextUnlockDay:
    def test_all_unlocked_returns_none(self) -> None:
        assert next_unlock_day(release_days=[0, 3, 7], days_elapsed=10) is None

    def test_returns_next_locked_day(self) -> None:
        assert next_unlock_day(release_days=[0, 3, 7], days_elapsed=0) == _EXPECTED_THREE

    def test_returns_soonest_locked_day(self) -> None:
        assert next_unlock_day(release_days=[0, 3, 5, 7], days_elapsed=4) == _EXPECTED_FIVE

    def test_empty_list_returns_none(self) -> None:
        assert next_unlock_day(release_days=[], days_elapsed=0) is None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
