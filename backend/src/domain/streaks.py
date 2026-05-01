"""Streak management domain functions."""

from __future__ import annotations

# Canonical weekday names accepted in ``Habit.notification_days``,
# mirroring ``date.strftime("%a")``.
WEEKDAY_ABBREVIATIONS: tuple[str, ...] = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
_VALID_WEEKDAY_LOWER: frozenset[str] = frozenset(d.lower() for d in WEEKDAY_ABBREVIATIONS)


def is_scheduled_on(notification_days: list[str] | None, weekday_name: str) -> bool:
    """Return True if ``weekday_name`` is in the cadence; raises on misspelled name."""
    target = weekday_name.lower()
    if target not in _VALID_WEEKDAY_LOWER:
        msg = f"weekday_name must be one of {WEEKDAY_ABBREVIATIONS}; got {weekday_name!r}"
        raise ValueError(msg)
    if not notification_days:
        return True
    return any(day.lower() == target for day in notification_days)


def update_streak(
    current_streak: int,
    *,
    did_check_in: bool,
    is_scheduled_today: bool = True,
) -> tuple[int, str]:
    """Increment on check-in, hold on unscheduled miss, reset on scheduled miss."""
    if did_check_in:
        return current_streak + 1, "streak_incremented"
    if not is_scheduled_today:
        return current_streak, "streak_held"
    return 0, "streak_reset"
