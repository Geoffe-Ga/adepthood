from __future__ import annotations

# mypy: ignore-errors
from dataclasses import dataclass
from datetime import date
from typing import Any, cast

import pytest  # type: ignore[import-not-found]
from fastapi.testclient import TestClient

from main import app
from routers import habits as habits_module

client = TestClient(app)
OK = 200


@pytest.fixture(autouse=True)
def clear_store() -> None:
    """Ensure the in-memory habit store is reset between tests."""
    habits_module._habits.clear()  # noqa: SLF001
    habits_module._goals.clear()  # noqa: SLF001
    habits_module._goal_completions.clear()  # noqa: SLF001


def _setup_sample_data() -> None:
    @dataclass
    class Habit:
        id: int
        name: str
        icon: str
        start_date: date
        energy_cost: int
        energy_return: int
        user_id: int

    @dataclass
    class Goal:
        id: int
        habit_id: int
        title: str
        tier: str
        target: float
        target_unit: str
        frequency: float
        frequency_unit: str
        is_additive: bool = True

    @dataclass
    class GoalCompletion:
        id: int
        goal_id: int
        user_id: int
        completed_units: float

    habit = Habit(
        id=1,
        name="Water",
        icon="💧",
        start_date=date.today(),
        energy_cost=0,
        energy_return=0,
        user_id=1,
    )
    habits_module._habits[habit.id] = habit  # type: ignore[assignment]  # noqa: SLF001

    g1 = Goal(
        id=1,
        habit_id=habit.id,
        title="Low",
        tier="low",
        target=1,
        target_unit="cup",
        frequency=1,
        frequency_unit="per_day",
        is_additive=True,
    )
    g2 = Goal(
        id=2,
        habit_id=habit.id,
        title="Stretch",
        tier="stretch",
        target=2,
        target_unit="cup",
        frequency=1,
        frequency_unit="per_day",
        is_additive=True,
    )
    habits_module._goals[g1.id] = g1  # type: ignore[assignment]  # noqa: SLF001
    habits_module._goals[g2.id] = g2  # type: ignore[assignment]  # noqa: SLF001

    habits_module._goal_completions.extend(  # noqa: SLF001
        [
            cast(Any, GoalCompletion(id=1, goal_id=g1.id, user_id=1, completed_units=3)),
            cast(Any, GoalCompletion(id=2, goal_id=g1.id, user_id=1, completed_units=4)),
        ]
    )


def test_habit_stats_aggregates_goal_completions() -> None:
    _setup_sample_data()
    res = client.get("/habits/1/stats")
    assert res.status_code == OK
    data = res.json()
    assert data["habit_id"] == 1
    goals = sorted(data["goals"], key=lambda g: g["goal_id"])
    assert goals == [
        {"goal_id": 1, "total_units": 7.0, "completion_count": 2},
        {"goal_id": 2, "total_units": 0.0, "completion_count": 0},
    ]
