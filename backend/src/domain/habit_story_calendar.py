"""Daily cells preserve recorded amounts while scoring the habit's native cadence."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import TYPE_CHECKING

from domain.streaks import PERIOD_UNITS, is_scheduled_on, period_start
from schemas.habit_story import HabitStoryDay, StoryTier

if TYPE_CHECKING:
    from domain.habit_story_types import GoalLogFact, HabitStoryContext
    from models.goal import Goal
    from models.habit import Habit

_TIERS: tuple[StoryTier, ...] = ("stretch", "clear", "low")


@dataclass(frozen=True)
class _CalendarScope:
    """Precomputed amounts and immutable inputs for the daily walk."""

    habit: Habit
    context: HabitStoryContext
    totals: dict[date, float]
    scored_totals: dict[date, float]
    timed_totals: dict[date, float]


def native_day(day: date, context: HabitStoryContext) -> date:
    """Identify the day or containing period used for scoring and denominators."""
    return period_start(day, context.cadence.unit) if context.cadence else day


def _scored_totals(totals: dict[date, float], context: HabitStoryContext) -> dict[date, float]:
    """Sum complete periods through today, without historical-as-of cell semantics."""
    result: defaultdict[date, float] = defaultdict(float)
    for day, amount in totals.items():
        result[native_day(day, context)] += amount
    return dict(result)


def _timed_totals(logs: Sequence[GoalLogFact]) -> dict[date, float]:
    """Keep signed operations on their represented day for residual conservation."""
    result: defaultdict[date, float] = defaultdict(float)
    for row in logs:
        result[row.local_day] += row.delta_units
    return dict(result)


def _tier_target(goal: Goal) -> float:
    """Match the tile's target per day or target times native-period frequency."""
    return goal.target * goal.frequency if goal.frequency_unit in PERIOD_UNITS else goal.target


def _reaches(total: float, goal: Goal, context: HabitStoryContext) -> bool:
    """Apply the habit-level polarity consistently across its tier ladder."""
    target = _tier_target(goal)
    return total <= target if context.subtractive else total >= target


def _highest_tier(total: float, scope: _CalendarScope) -> StoryTier | None:
    """Take the highest named qualifying tier, including the strictest subtractive limit."""
    for tier in _TIERS:
        if any(
            goal.tier == tier and _reaches(total, goal, scope.context) for goal in scope.habit.goals
        ):
            return tier
    return None


def _day_cell(day: date, scope: _CalendarScope) -> HabitStoryDay:
    """An unrecorded pre-start day cannot become an invented abstention fact."""
    logged = day in scope.totals
    alive = day >= scope.habit.start_date
    total = scope.scored_totals.get(native_day(day, scope.context), 0.0)
    tier = _highest_tier(total, scope) if alive or logged else None
    units = scope.totals.get(day, 0.0)
    return HabitStoryDay(
        date=day,
        units=units,
        unknown_time_units=units - scope.timed_totals.get(day, 0.0),
        tier=tier,
        logged=logged,
        scheduled=alive and is_scheduled_on(scope.habit.notification_days, day.strftime("%a")),
        met=tier is not None,
    )


def build_day_cells(
    habit: Habit,
    totals: dict[date, float],
    logs: Sequence[GoalLogFact],
    context: HabitStoryContext,
) -> list[HabitStoryDay]:
    """Populate real calendar dates from the earliest represented fact through today."""
    scope = _CalendarScope(
        habit, context, totals, _scored_totals(totals, context), _timed_totals(logs)
    )
    cursor = min(habit.start_date, min(totals, default=habit.start_date))
    cells = []
    while cursor <= context.today:
        cells.append(_day_cell(cursor, scope))
        cursor += timedelta(days=1)
    return cells
