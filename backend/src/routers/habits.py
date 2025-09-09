from __future__ import annotations

from fastapi import APIRouter, HTTPException

from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from schemas.habit_stats import GoalStats, HabitStats

router = APIRouter(prefix="/habits", tags=["habits"])

# In-memory stores for tests; populated directly in tests.
_habits: dict[int, Habit] = {}
_goals: dict[int, Goal] = {}
_goal_completions: list[GoalCompletion] = []


@router.get("/{habit_id}/stats", response_model=HabitStats)
def habit_stats(habit_id: int) -> HabitStats:
    """Return aggregated completion statistics for a habit."""

    habit = _habits.get(habit_id)
    if habit is None:
        raise HTTPException(status_code=404, detail="Habit not found")

    goals = [g for g in _goals.values() if g.habit_id == habit_id]
    goal_stats: list[GoalStats] = []
    for goal in goals:
        comps = [c for c in _goal_completions if c.goal_id == goal.id]
        total_units = sum(c.completed_units for c in comps)
        goal_stats.append(
            GoalStats(
                goal_id=goal.id,
                total_units=total_units,
                completion_count=len(comps),
            )
        )

    return HabitStats(habit_id=habit_id, goals=goal_stats)
