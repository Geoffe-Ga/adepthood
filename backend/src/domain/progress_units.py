"""Actual daily units for the progress arc; no threshold or cadence conversion."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from datetime import date, timedelta
from typing import TYPE_CHECKING

from domain.constants import TOTAL_PROGRAM_DAYS
from schemas.progress import HabitUnitHistory, HabitUnitsDay

if TYPE_CHECKING:
    from models.goal import Goal
    from models.goal_completion import GoalCompletion


def habit_unit_histories(
    habit_id: int | None,
    goals: Sequence[Goal],
    completions: Sequence[GoalCompletion],
    *,
    start: date | None,
    today: date,
) -> list[HabitUnitHistory]:
    """Sum siblings only within the same measure and keep the programme's dates.

    Unlike engagement, logged units belong to their actual local day even for
    weekly/monthly or subtractive goals. A missing anchor cannot invent dates.
    """
    if start is None:
        return []
    goal_units = {goal.id: goal.target_unit for goal in goals if goal.habit_id == habit_id}
    totals = _unit_totals(goal_units, completions, start, today)
    return _histories(goal_units, totals, start, today)


def _histories(
    goal_units: dict[int | None, str],
    totals: dict[tuple[str, date], float],
    start: date,
    today: date,
) -> list[HabitUnitHistory]:
    """Pad each measure with actual programme dates, stopping at the known extent."""
    days = min(TOTAL_PROGRAM_DAYS, max(0, (today - start).days + 1))
    return [
        HabitUnitHistory(
            unit=unit,
            days=[
                HabitUnitsDay(
                    date=start + timedelta(days=index),
                    units=totals[unit, start + timedelta(days=index)],
                )
                for index in range(days)
            ],
        )
        for unit in dict.fromkeys(goal_units.values())
    ]


def _unit_totals(
    goal_units: dict[int | None, str],
    completions: Sequence[GoalCompletion],
    start: date,
    today: date,
) -> dict[tuple[str, date], float]:
    """Keep ledger-local identities and count each retained row once."""
    totals: dict[tuple[str, date], float] = defaultdict(float)
    for row in completions:
        if row.goal_id in goal_units and start <= row.local_day <= today:
            totals[goal_units[row.goal_id], row.local_day] += max(0, row.completed_units)
    return totals
