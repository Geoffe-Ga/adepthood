"""Streak management domain functions."""

from __future__ import annotations

# Canonical weekday names accepted in ``Habit.notification_days``,
# mirroring ``date.strftime("%a")``.
WEEKDAY_ABBREVIATIONS: tuple[str, ...] = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
_VALID_WEEKDAY_LOWER: frozenset[str] = frozenset(d.lower() for d in WEEKDAY_ABBREVIATIONS)


def is_scheduled_on(notification_days: list[str] | None, weekday_name: str) -> bool:
    """Return True if ``weekday_name`` is in the cadence (None / empty == every day).

    ``weekday_name`` must be a 3-letter abbreviation from
    :data:`WEEKDAY_ABBREVIATIONS`; passing ``"monday"`` or ``"MO"``
    raises ``ValueError`` rather than silently returning False, which
    would zero a streak that should be held.
    """
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
    """Update a streak count based on a check-in result and the day's cadence.

    A miss on a non-scheduled day holds the streak (no work was expected);
    a miss on a scheduled day resets it; any successful check-in
    increments.  ``is_scheduled_today`` defaults to ``True`` so legacy
    callers that have not threaded cadence through keep their
    every-day-counts behaviour.
    """
    if did_check_in:
        return current_streak + 1, "streak_incremented"
    if not is_scheduled_today:
        return current_streak, "streak_held"
    return 0, "streak_reset"
