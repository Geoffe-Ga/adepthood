"""Daily units for the progress arc and their trailing seven-day mean.

No threshold or cadence conversion: a day keeps exactly what was logged, and
the mean only smooths it. A measure nothing was ever logged in is left out.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from datetime import date, timedelta
from typing import TYPE_CHECKING

from domain.constants import TOTAL_PROGRAM_DAYS
from domain.progress_rhythm import ROLLING_WINDOW_DAYS
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
    """Pad each logged measure with actual programme dates, stopping at the known extent."""
    count = min(TOTAL_PROGRAM_DAYS, max(0, (today - start).days + 1))
    dates = [start + timedelta(days=index) for index in range(count)]
    logged = {unit for unit, _day in totals}
    return [
        HabitUnitHistory(unit=unit, days=_smoothed(unit, dates, totals))
        for unit in dict.fromkeys(goal_units.values())
        if unit in logged
    ]


def _smoothed(
    unit: str, dates: list[date], totals: dict[tuple[str, date], float]
) -> list[HabitUnitsDay]:
    """Each day's units beside the mean of it and up to six days before it."""
    units = [totals.get((unit, day), 0.0) for day in dates]
    return [
        HabitUnitsDay(
            date=day,
            units=units[index],
            average=_mean(units[max(0, index - ROLLING_WINDOW_DAYS + 1) : index + 1]),
        )
        for index, day in enumerate(dates)
    ]


def _mean(values: list[float]) -> float:
    """The arithmetic mean of a non-empty window."""
    return sum(values) / len(values)


def _unit_totals(
    goal_units: dict[int | None, str],
    completions: Sequence[GoalCompletion],
    start: date,
    today: date,
) -> dict[tuple[str, date], float]:
    """Keep ledger-local identities and count each retained row once."""
    totals: dict[tuple[str, date], float] = defaultdict(float)
    for row in completions:
        if (
            row.goal_id in goal_units
            and start <= row.local_day <= today
            and row.completed_units > 0
        ):
            totals[goal_units[row.goal_id], row.local_day] += row.completed_units
    return totals
