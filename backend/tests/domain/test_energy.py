from datetime import date

from app.domain.energy import EnergyPlanItem, Habit, generate_plan


def test_generate_plan_creates_21_day_schedule() -> None:
    habits = [Habit(id=1, name="Run", energy=3), Habit(id=2, name="Sleep", energy=-1)]
    start = date(2024, 1, 1)

    plan, reason = generate_plan(habits, start)

    assert reason == "generated_21_day_plan"
    assert len(plan.items) == 21  # noqa: PLR2004
    assert plan.net_energy == 3 * 11 + (-1) * 10
    assert plan.items[0] == EnergyPlanItem(habit_id=1, date=start)
