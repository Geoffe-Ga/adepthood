"""Pure energy planning domain functions."""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta


@dataclass(frozen=True)
class Habit:
    """A habit with associated energy cost and return."""

    id: int
    name: str
    energy_cost: int
    energy_return: int
    start_date: date | None = None

    @property
    def net_energy(self) -> int:
        """Net energy gained from performing the habit."""
        return self.energy_return - self.energy_cost


@dataclass(frozen=True)
class EnergyPlanItem:
    """One scheduled habit occurrence."""

    habit_id: int
    date: date


@dataclass(frozen=True)
class EnergyPlan:
    """A schedule of habits covering one stage cycle and its cumulative energy."""

    items: list[EnergyPlanItem]
    net_energy: int


# One standard stage cycle in the APTITUDE program. Stages 1-8 each last
# 21 days (3 weeks). Energy plans are generated for this duration so the
# user has a full stage's worth of scheduled habits at a time.
PLAN_DURATION_DAYS = 21


def generate_plan(habits: Sequence[Habit], start_date: date) -> tuple[EnergyPlan, str]:
    """Generate a single-stage energy plan cycling through ``habits``.

    The plan covers :data:`PLAN_DURATION_DAYS` (21 days, one standard stage
    cycle). Returns the plan and a ``reason_code`` for auditability.
    """

    if not habits:
        raise ValueError("habits must not be empty")

    items: list[EnergyPlanItem] = []
    net_energy = 0
    for offset in range(PLAN_DURATION_DAYS):
        habit = habits[offset % len(habits)]
        plan_date = start_date + timedelta(days=offset)
        if habit.start_date is not None and habit.start_date > plan_date:
            continue
        items.append(EnergyPlanItem(habit_id=habit.id, date=plan_date))
        net_energy += habit.net_energy
    plan = EnergyPlan(items=items, net_energy=net_energy)
    return plan, "generated_21_day_plan"
