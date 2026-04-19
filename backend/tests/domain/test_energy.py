from datetime import date

from domain.energy import PLAN_DURATION_DAYS, EnergyPlanItem, Habit, generate_plan


def test_plan_duration_days_matches_one_stage_cycle() -> None:
    assert PLAN_DURATION_DAYS == 21


def test_generate_plan_creates_21_day_schedule() -> None:
    habits = [
        Habit(id=1, name="Run", energy_cost=2, energy_return=5),
        Habit(id=2, name="Sleep", energy_cost=1, energy_return=0),
    ]
    start = date(2024, 1, 1)

    plan, reason = generate_plan(habits, start)

    assert reason == "generated_21_day_plan"
    assert len(plan.items) == PLAN_DURATION_DAYS
    expected_net = habits[0].net_energy * 11 + habits[1].net_energy * 10
    assert plan.net_energy == expected_net
    assert plan.items[0] == EnergyPlanItem(habit_id=1, date=start)
