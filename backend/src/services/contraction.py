"""Read-only gathering of a user's habit-foundation signals for contraction math.

The DB-aware companion to :mod:`domain.contraction`. It reads a user's habits,
their additive goals, and the recent goal completions with a bounded, constant
number of batched queries (never one-per-habit), buckets the completions into
user-local days in memory, and derives each habit's consecutive unmet / unchecked
day counts. The result is handed to the pure detection function.

Strictly read-only: it issues ``SELECT`` statements only and never stages a
write, so calling it during a resonance pass can have no side effect on
progression or history.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.contraction import (
    FOUNDATION_UNCHECKED_CONSECUTIVE_DAYS,
    FOUNDATION_UNMET_CONSECUTIVE_DAYS,
    ContractionAggregates,
    HabitFoundationSignal,
)
from domain.dates import to_user_date_bucket, today_in_tz
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit

# The furthest back the day-walk ever looks. It is the wider of the two windows:
# once a walk reaches this many consecutive qualifying days the habit is already
# flagged, so counting further would change no decision while lengthening the
# query and the loop.
_OBSERVATION_WINDOW_DAYS = max(
    FOUNDATION_UNMET_CONSECUTIVE_DAYS, FOUNDATION_UNCHECKED_CONSECUTIVE_DAYS
)


async def _gather_habit_goal_rows(
    session: AsyncSession, user_id: int
) -> list[tuple[int, int, date]]:
    """Read ``(habit_id, goal_id, habit_start_date)`` for each additive goal, in one query.

    Subtractive goals are excluded at the SQL layer: for them the absence of a
    completion is success, so their silence must never read as a contraction.
    """
    result = await session.execute(
        select(col(Habit.id), col(Goal.id), col(Habit.start_date))
        .join(Goal, col(Goal.habit_id) == col(Habit.id))
        .where(col(Habit.user_id) == user_id, col(Goal.is_additive).is_(True))
    )
    return [(habit_id, goal_id, start_date) for habit_id, goal_id, start_date in result.all()]


async def _gather_completion_days(
    session: AsyncSession,
    goal_ids: list[int],
    user_id: int,
    user_timezone: str,
    since: date,
) -> dict[int, dict[date, float]]:
    """Sum completion units per goal per user-local day, over one bounded query.

    Keyed ``goal_id -> {local_day -> total_units}`` so the day-walk can ask, for
    any day, both "was there a check-in?" (key present) and "did it meet the
    goal?" (value > 0).
    """
    totals: dict[int, dict[date, float]] = defaultdict(lambda: defaultdict(float))
    if not goal_ids:
        return totals
    result = await session.execute(
        select(
            GoalCompletion.goal_id, GoalCompletion.timestamp, GoalCompletion.completed_units
        ).where(
            col(GoalCompletion.user_id) == user_id,
            col(GoalCompletion.goal_id).in_(goal_ids),
        )
    )
    for goal_id, timestamp, units in result.all():
        day = to_user_date_bucket(timestamp, user_timezone)
        if day >= since:
            totals[goal_id][day] += units
    return totals


def _consecutive_days(
    day_totals: dict[date, float],
    *,
    today: date,
    earliest: date,
    unmet: bool,
) -> int:
    """Count consecutive qualifying days walking back from ``today`` to ``earliest``.

    ``unmet=True`` counts days that carry a zero-unit check-in (logged but not
    met); ``unmet=False`` counts days with no check-in at all. The walk stops at
    the first non-qualifying day or once it crosses ``earliest`` (the habit's
    start, so a brand-new habit can never accrue a long unchecked run).
    """
    streak = 0
    cursor = today
    while cursor >= earliest:
        present = cursor in day_totals
        qualifies = (present and day_totals[cursor] <= 0.0) if unmet else not present
        if not qualifies:
            break
        streak += 1
        cursor -= timedelta(days=1)
    return streak


def _build_signal(
    habit_id: int,
    day_totals: dict[date, float],
    *,
    today: date,
    start_date: date,
) -> HabitFoundationSignal:
    """Derive one habit's unmet / unchecked consecutive-day counts."""
    earliest = max(start_date, today - timedelta(days=_OBSERVATION_WINDOW_DAYS))
    return HabitFoundationSignal(
        habit_id=habit_id,
        consecutive_unmet_days=_consecutive_days(
            day_totals, today=today, earliest=earliest, unmet=True
        ),
        consecutive_unchecked_days=_consecutive_days(
            day_totals, today=today, earliest=earliest, unmet=False
        ),
    )


def _fold_by_habit(
    habit_goal_rows: list[tuple[int, int, date]],
    completion_days: dict[int, dict[date, float]],
) -> tuple[dict[int, dict[date, float]], dict[int, date]]:
    """Collapse goal-keyed day totals onto their habit and record each habit's start.

    A habit reads as "checked" on any day any of its goals was logged, so each
    goal's day totals are summed into the owning habit's totals.
    """
    per_habit_totals: dict[int, dict[date, float]] = defaultdict(lambda: defaultdict(float))
    habit_start: dict[int, date] = {}
    for habit_id, goal_id, start_date in habit_goal_rows:
        habit_start[habit_id] = start_date
        for day, units in completion_days.get(goal_id, {}).items():
            per_habit_totals[habit_id][day] += units
    return per_habit_totals, habit_start


async def gather_contraction_aggregates(
    session: AsyncSession,
    user_id: int,
    user_timezone: str = "UTC",
) -> ContractionAggregates:
    """Assemble a user's habit-foundation snapshot with two batched, read-only queries.

    One query reads the user's additive goals (subtractive goals excluded), a
    second reads their recent completions; the day-walk then runs purely in
    memory. Multiple goals under one habit are folded into that habit's day
    totals, so a habit reads as "checked" on any day any of its goals was logged.
    """
    today = today_in_tz(user_timezone)
    since = today - timedelta(days=_OBSERVATION_WINDOW_DAYS)
    habit_goal_rows = await _gather_habit_goal_rows(session, user_id)
    if not habit_goal_rows:
        return ContractionAggregates(habits=[])
    goal_ids = [goal_id for _, goal_id, _ in habit_goal_rows]
    completion_days = await _gather_completion_days(
        session, goal_ids, user_id, user_timezone, since
    )
    per_habit_totals, habit_start = _fold_by_habit(habit_goal_rows, completion_days)
    return ContractionAggregates(
        habits=[
            _build_signal(
                habit_id, per_habit_totals[habit_id], today=today, start_date=habit_start[habit_id]
            )
            for habit_id in habit_start
        ]
    )
