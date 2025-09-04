"""Streak management domain functions."""

from __future__ import annotations


def update_streak(current_streak: int, did_check_in: bool) -> tuple[int, str]:
    """Update a streak count based on a check-in result."""

    if did_check_in:
        return current_streak + 1, "streak_incremented"
    return 0, "streak_reset"
