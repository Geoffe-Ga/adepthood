"""Pure energy planning domain functions."""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta


@dataclass(frozen=True)
class Habit:
    """A habit with an associated energy value."""

    id: int
    name: str
    energy: int


@dataclass(frozen=True)
class EnergyPlanItem:
    """One scheduled habit occurrence."""

    habit_id: int
    date: date


@dataclass(frozen=True)
class EnergyPlan:
    """A 21-day schedule of habits and its cumulative energy."""

    items: list[EnergyPlanItem]
    net_energy: int


def generate_plan(habits: Sequence[Habit], start_date: date) -> tuple[EnergyPlan, str]:
    """Generate a 21-day energy plan cycling through ``habits``.

    Returns the plan and a ``reason_code`` for auditability.
    """

    if not habits:
        raise ValueError("habits must not be empty")

    items: list[EnergyPlanItem] = []
    net_energy = 0
    for offset in range(21):
        habit = habits[offset % len(habits)]
        items.append(EnergyPlanItem(habit_id=habit.id, date=start_date + timedelta(days=offset)))
        net_energy += habit.energy
    plan = EnergyPlan(items=items, net_energy=net_energy)
    return plan, "generated_21_day_plan"
