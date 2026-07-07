"""Unit tests for course domain logic — drip-feed gating and progress calculation."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from domain.course import (
    compute_days_elapsed,
    filter_content_for_user,
    next_unlock_day,
    unlocked_chapter_count,
)

_EXPECTED_THREE = 3
_EXPECTED_TWO = 2
_EXPECTED_SEVEN = 7
_EXPECTED_EIGHT = 8


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


class TestUnlockedChapterCount:
    """The proportional drip: ``ceil(total * day / duration)`` clamped."""

    def test_handoff_example(self) -> None:
        # 14 chapters over a 21-day stage: by day 10, seven have dripped.
        assert (
            unlocked_chapter_count(total=14, duration_days=21, day_in_stage=10) == _EXPECTED_SEVEN
        )

    def test_first_open_day_yields_at_least_one(self) -> None:
        # Day 1 of a long stage still opens the first chapter, so a seeded,
        # unlocked stage is never empty ("No Content Yet" is unreachable).
        assert unlocked_chapter_count(total=14, duration_days=21, day_in_stage=1) == 1

    def test_final_day_opens_everything(self) -> None:
        assert unlocked_chapter_count(total=14, duration_days=21, day_in_stage=21) == 14

    def test_past_stage_day_caps_at_total(self) -> None:
        assert unlocked_chapter_count(total=14, duration_days=21, day_in_stage=999) == 14

    def test_non_positive_day_opens_nothing(self) -> None:
        assert unlocked_chapter_count(total=14, duration_days=21, day_in_stage=0) == 0
        assert unlocked_chapter_count(total=14, duration_days=21, day_in_stage=-3) == 0

    def test_empty_stage_is_zero(self) -> None:
        assert unlocked_chapter_count(total=0, duration_days=21, day_in_stage=10) == 0


class TestFilterContentForUser:
    """Locking is by ordinal position, not release_day."""

    def test_locks_by_ordinal_position(self) -> None:
        items = [
            {"release_day": 0, "url": "https://a.com"},
            {"release_day": 3, "url": "https://b.com"},
            {"release_day": 7, "url": "https://c.com"},
        ]
        result = filter_content_for_user(items, unlocked_count=1, read_content_ids=set())
        unlocked = [r for r in result if not r["is_locked"]]
        locked = [r for r in result if r["is_locked"]]
        assert len(unlocked) == 1
        assert len(locked) == _EXPECTED_TWO
        # Locked items should have no URL.
        for item in locked:
            assert item["url"] is None

    def test_non_dense_release_days_still_gate_by_position(self) -> None:
        # Stage 1 skips release_day 11; positional gating is unaffected by
        # the gap — the first two ordinals open, the third stays locked.
        items = [
            {"release_day": 0, "url": "https://a.com"},
            {"release_day": 10, "url": "https://b.com"},
            {"release_day": 12, "url": "https://c.com"},
        ]
        result = filter_content_for_user(
            items, unlocked_count=_EXPECTED_TWO, read_content_ids=set()
        )
        assert [r["is_locked"] for r in result] == [False, False, True]

    def test_all_unlocked_when_count_covers_all(self) -> None:
        items = [
            {"release_day": 0, "url": "https://a.com"},
            {"release_day": 3, "url": "https://b.com"},
            {"release_day": 7, "url": "https://c.com"},
        ]
        result = filter_content_for_user(
            items, unlocked_count=_EXPECTED_THREE, read_content_ids=set()
        )
        assert all(not r["is_locked"] for r in result)

    def test_read_items_marked(self) -> None:
        items = [
            {"id": 1, "release_day": 0, "url": "https://a.com"},
            {"id": 2, "release_day": 0, "url": "https://b.com"},
        ]
        result = filter_content_for_user(items, unlocked_count=_EXPECTED_TWO, read_content_ids={1})
        assert result[0]["is_read"] is True
        assert result[1]["is_read"] is False


class TestNextUnlockDay:
    def test_all_unlocked_returns_none(self) -> None:
        assert next_unlock_day(total=3, duration_days=21, day_in_stage=21) is None

    def test_reports_day_the_next_chapter_drips(self) -> None:
        # 3 chapters over 21 days: on day 1 only one is open; the second
        # drips on day 8 (the first day ceil(3*D/21) reaches 2).
        assert next_unlock_day(total=3, duration_days=21, day_in_stage=1) == _EXPECTED_EIGHT

    def test_matches_unlocked_chapter_count_boundary(self) -> None:
        # The reported day is exactly when unlocked_chapter_count ticks up.
        day = next_unlock_day(total=14, duration_days=21, day_in_stage=10)
        assert day is not None
        before = unlocked_chapter_count(total=14, duration_days=21, day_in_stage=day - 1)
        at = unlocked_chapter_count(total=14, duration_days=21, day_in_stage=day)
        assert at == before + 1

    def test_empty_stage_returns_none(self) -> None:
        assert next_unlock_day(total=0, duration_days=21, day_in_stage=0) is None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
