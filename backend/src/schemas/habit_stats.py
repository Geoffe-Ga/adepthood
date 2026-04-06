"""Habit statistics response schema."""

from __future__ import annotations

from pydantic import BaseModel


class HabitStats(BaseModel):
    """Aggregated statistics for a single habit.

    Computed from the habit's goal completions. The shape matches
    the frontend ``HabitStatsData`` interface so the client can
    consume the response directly.
    """

    day_labels: list[str]
    values: list[float]
    completions_by_day: list[int]
    longest_streak: int
    current_streak: int
    total_completions: int
    completion_rate: float
    completion_dates: list[str]
