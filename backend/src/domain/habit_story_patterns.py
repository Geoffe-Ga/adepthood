"""Recording-time patterns never infer timestamps from historical daily totals."""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from domain.dates import ensure_aware, to_user_date
from domain.time_of_day import time_of_day
from schemas.habit_story import HabitStoryLog, HabitStoryPatterns

if TYPE_CHECKING:
    from domain.habit_story_types import GoalLogFact, HabitStoryContext
    from schemas.habit_story import HabitStoryDay

LOG_LIST_LIMIT = 200
_TIME_BUCKETS = ("dawn", "day", "dusk", "night")
_WEEKDAYS = 7


def build_patterns(
    days: Sequence[HabitStoryDay], logs: Sequence[GoalLogFact], context: HabitStoryContext
) -> HabitStoryPatterns:
    """Roll up the complete event population, independent of the drawn-log cap."""
    weekday_units = [0.0] * _WEEKDAYS
    matrix = [[0.0] * len(_TIME_BUCKETS) for _ in range(_WEEKDAYS)]
    for day in days:
        weekday_units[day.date.weekday()] += day.units
    recording_days = []
    for log in logs:
        recorded_on = to_user_date(context.timezone, ensure_aware(log.timestamp))
        recording_days.append(recorded_on)
        bucket = _TIME_BUCKETS.index(time_of_day(log.timestamp, context.timezone))
        matrix[recorded_on.weekday()][bucket] += log.delta_units
    return HabitStoryPatterns(
        weekday_units=weekday_units,
        weekday_by_time_of_day=matrix,
        unknown_time_units=sum(day.unknown_time_units for day in days),
        time_of_day_available_since=min(recording_days, default=None),
    )


def recent_logs(logs: Sequence[GoalLogFact]) -> list[HabitStoryLog]:
    """Stable newest-first operations, preserving signed corrections and recording timestamps."""
    ordered = sorted(logs, key=lambda row: (ensure_aware(row.timestamp), row.id), reverse=True)
    return [
        HabitStoryLog(
            timestamp=ensure_aware(row.timestamp),
            local_day=row.local_day,
            delta_units=row.delta_units,
            via_timer=row.via_timer,
            source=row.source,
        )
        for row in ordered[:LOG_LIST_LIMIT]
    ]
