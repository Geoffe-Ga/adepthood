"""Pure Habit Story construction from owned lifetime rows and actual log facts."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, timedelta
from typing import TYPE_CHECKING, Literal

from domain.constants import STAGE_DURATIONS_DAYS
from domain.habit_story_calendar import build_day_cells
from domain.habit_story_continuity import build_continuity
from domain.habit_story_patterns import build_patterns, recent_logs
from domain.habit_story_rollups import build_rates, build_tiers
from domain.streaks import sum_units_by_user_day
from schemas.habit_story import HabitStoryResponse, HabitStoryStage

if TYPE_CHECKING:
    from domain.habit_story_types import GoalLogFact, HabitStoryContext
    from models.goal_completion import GoalCompletion
    from models.habit import Habit
    from schemas.habit_story import HabitStoryDay


def _stages(
    habit: Habit, days: Sequence[HabitStoryDay], context: HabitStoryContext
) -> list[HabitStoryStage]:
    """Only known program boundaries intersecting real history are drawn."""
    cursor = context.program_started_on
    if cursor is None or not _has_stage_calendar(habit, days):
        return []
    stages = []
    for number, duration in enumerate(STAGE_DURATIONS_DAYS, 1):
        closes = cursor + timedelta(days=duration - 1)
        if _stage_intersects(days[0].date, cursor, closes, context):
            stages.append(HabitStoryStage(stage_number=number, opens_on=cursor, closes_on=closes))
        cursor += timedelta(days=duration)
    return stages


def _has_stage_calendar(habit: Habit, days: Sequence[HabitStoryDay]) -> bool:
    """A carryover or unknown calendar has no synthetic program boundaries."""
    return not habit.is_carryover and bool(days)


def _stage_intersects(first: date, opens: date, closes: date, context: HabitStoryContext) -> bool:
    """Keep stages intersecting the series while preserving their real bounds."""
    return closes >= first and opens <= context.today


def _cadence(context: HabitStoryContext) -> Literal["day", "week", "month"]:
    """Name the authoritative goal cadence, retaining daily/per-session behavior."""
    if context.cadence is None:
        return "day"
    return "week" if context.cadence.unit == "per_week" else "month"


def build_habit_story(
    habit: Habit,
    completions: Sequence[GoalCompletion],
    logs: Sequence[GoalLogFact],
    *,
    context: HabitStoryContext,
) -> HabitStoryResponse:
    """Describe history without a database query, current clock read, or synthetic event."""
    rows, recorded = _recorded_through_today(completions, logs, context)
    totals = sum_units_by_user_day(rows)
    days = build_day_cells(habit, totals, recorded, context)
    return HabitStoryResponse(
        polarity="subtractive" if context.subtractive else "additive",
        cadence=_cadence(context),
        unit=habit.goals[0].target_unit if habit.goals else "",
        start_date=habit.start_date,
        today=context.today,
        logged_days=len(totals),
        log_count=len(recorded),
        days=days,
        stages=_stages(habit, days, context),
        continuity=build_continuity(totals, days, context),
        rates=build_rates(days, context),
        tiers=build_tiers(days, context),
        patterns=build_patterns(days, recorded, context),
        logs=recent_logs(recorded),
        observations=[],
        milestones=[],
    )


def _recorded_through_today(
    completions: Sequence[GoalCompletion], logs: Sequence[GoalLogFact], context: HabitStoryContext
) -> tuple[list[GoalCompletion], list[GoalLogFact]]:
    """Keep future represented days out of both aggregate and event populations."""
    return (
        [row for row in completions if row.local_day <= context.today],
        [row for row in logs if row.local_day <= context.today],
    )
