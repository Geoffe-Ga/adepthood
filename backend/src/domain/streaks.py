"""Streak management domain functions."""

from __future__ import annotations

# Canonical weekday names accepted in ``Habit.notification_days``.  Using
# three-letter abbreviations (mirroring ``date.strftime("%a")``) so a
# typo on either side surfaces as a hard validation failure rather than
# a silent "every day is unscheduled" miscount.
WEEKDAY_ABBREVIATIONS: tuple[str, ...] = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def is_scheduled_on(notification_days: list[str] | None, weekday_name: str) -> bool:
    """Return True if ``weekday_name`` is in the habit's scheduled cadence.

    A habit with ``notification_days = None`` (or an empty list) is
    treated as "every day", matching the legacy behaviour from before
    BUG-STREAK-001 landed.  Comparisons are case-insensitive so an
    ``"mon"`` from the frontend and a ``"Mon"`` from the DB both
    resolve to True.
    """
    if not notification_days:
        return True
    target = weekday_name.lower()
    return any(day.lower() == target for day in notification_days)


def update_streak(
    current_streak: int,
    *,
    did_check_in: bool,
    is_scheduled_today: bool = True,
) -> tuple[int, str]:
    """Update a streak count based on a check-in result and the day's cadence.

    BUG-STREAK-001: previously a missed day always reset the streak to
    zero, so a habit with ``notification_days = ["Mon", "Wed", "Fri"]``
    lost its streak every Tuesday because no check-in arrived.  Now
    when ``is_scheduled_today`` is ``False`` and the user did not check
    in, the streak is *held*: neither incremented (no work was done)
    nor reset (no work was expected).  An explicit miss on a scheduled
    day still resets, and a successful check-in on any day still
    increments -- consistent with users opportunistically logging
    habits outside the schedule.

    The ``is_scheduled_today`` keyword defaults to ``True`` so existing
    callers that have not threaded cadence through yet keep their
    every-day-counts behaviour.
    """
    if did_check_in:
        return current_streak + 1, "streak_incremented"
    if not is_scheduled_today:
        return current_streak, "streak_held"
    return 0, "streak_reset"
