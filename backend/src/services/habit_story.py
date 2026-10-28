"""Read owned lifetime history; logged events add recording time where it is known."""

from __future__ import annotations

from datetime import date
from typing import TYPE_CHECKING, cast

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from domain.dates import ensure_aware, to_user_date, today_in_tz
from domain.habit_story import build_habit_story
from domain.habit_story_types import GoalLogFact, HabitStoryContext
from models.goal import Goal
from models.goal_log_event import GoalLogEvent
from models.stage_progress import StageProgress
from services.streaks import period_cadence_for_goals, subtractive_context_for_goals

if TYPE_CHECKING:
    from models.habit import Habit
    from schemas.habit_story import HabitStoryResponse


async def _logs(session: AsyncSession, habit_id: int, user_id: int) -> list[GoalLogFact]:
    """Query actual operations with independent owner and owned-goal predicates.

    Aggregate rows logged before the event table existed have no events, so their
    recording time stays unknown rather than being reconstructed.
    """
    rows = await session.execute(
        select(
            col(GoalLogEvent.id),
            col(GoalLogEvent.timestamp),
            col(GoalLogEvent.local_day),
            col(GoalLogEvent.delta_units),
            col(GoalLogEvent.via_timer),
            col(GoalLogEvent.source),
        ).where(
            col(GoalLogEvent.user_id) == user_id,
            col(GoalLogEvent.goal_id).in_(
                select(col(Goal.id)).where(col(Goal.habit_id) == habit_id)
            ),
        )
    )
    return [
        GoalLogFact(cast("int", event_id), timestamp, local_day, delta, via_timer, source)
        for event_id, timestamp, local_day, delta, via_timer, source in rows.tuples()
    ]


async def _program_started_on(session: AsyncSession, user_id: int, timezone: str) -> date | None:
    """Use the current known program anchor without provisioning one on a read."""
    progress = await session.scalar(
        select(StageProgress).where(col(StageProgress.user_id) == user_id)
    )
    if progress is None or progress.program_started_at is None:
        return None
    return to_user_date(timezone, ensure_aware(progress.program_started_at))


async def read_habit_story(
    session: AsyncSession, habit: Habit, user_id: int, timezone: str
) -> HabitStoryResponse:
    """Build the response only after the route has resolved full-history ownership."""
    context = HabitStoryContext(
        today=today_in_tz(timezone),
        timezone=timezone,
        subtractive=subtractive_context_for_goals(habit.goals, habit.start_date),
        cadence=period_cadence_for_goals(habit.goals, habit.start_date),
        program_started_on=await _program_started_on(session, user_id, timezone),
    )
    rows = [row for goal in habit.goals for row in goal.completions if row.user_id == user_id]
    logs = await _logs(session, cast("int", habit.id), user_id)
    return build_habit_story(habit, rows, logs, context=context)
