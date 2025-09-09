"""Habit statistics schemas."""

from __future__ import annotations

from pydantic import BaseModel


class GoalStats(BaseModel):
    """Aggregated completion data for a single goal."""

    goal_id: int
    total_units: float
    completion_count: int


class HabitStats(BaseModel):
    """Aggregated statistics for a habit across its goals."""

    habit_id: int
    goals: list[GoalStats]
