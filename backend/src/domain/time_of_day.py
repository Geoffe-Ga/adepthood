"""Shared user-local time buckets for habit logs and practice sessions."""

from datetime import datetime
from typing import Literal

from domain.dates import ensure_aware, now_in_tz

DAWN_START_HOUR = 5
DAY_START_HOUR = 9
DUSK_START_HOUR = 17
NIGHT_START_HOUR = 21

TimeOfDay = Literal["dawn", "day", "dusk", "night"]


def time_of_day(timestamp: datetime, tz: str | None) -> TimeOfDay:
    """Bucket an instant in the user's timezone, falling back to UTC for legacy zones."""
    hour = ensure_aware(timestamp).astimezone(now_in_tz(tz).tzinfo).hour
    if DAWN_START_HOUR <= hour < DAY_START_HOUR:
        return "dawn"
    if DAY_START_HOUR <= hour < DUSK_START_HOUR:
        return "day"
    if DUSK_START_HOUR <= hour < NIGHT_START_HOUR:
        return "dusk"
    return "night"
