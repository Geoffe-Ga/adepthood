"""Every shared cadence fixture retains both canonical Habit Story run counts."""

from datetime import date
from pathlib import Path

import pytest
from pydantic import BaseModel

from domain.habit_story import build_habit_story
from domain.habit_story_types import HabitStoryContext
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from services.streaks import period_cadence_for_goals, subtractive_context_for_goals


class _ParityCase(BaseModel):
    """Validate fixture values without letting untyped JSON bypass test type checks."""

    name: str
    timezone: str
    today: date
    start_date: date
    is_additive: bool
    frequency: float
    frequency_unit: str
    targets: dict[str, float]
    completions: list[tuple[date, float]]
    expected: dict[str, int]


class _Fixture(BaseModel):
    """The shared client/server cadence corpus."""

    cases: list[_ParityCase]


_PATH = Path(__file__).resolve().parents[1] / "fixtures/streak_parity/cadence_streaks.json"
_CASES = _Fixture.model_validate_json(_PATH.read_text(encoding="utf-8")).cases


@pytest.mark.parametrize("case", _CASES, ids=[case.name for case in _CASES])
def test_story_matches_every_canonical_cadence_fixture(case: _ParityCase) -> None:
    """Story, list, stats, and frontend share identical period current/longest owners."""
    habit = Habit(
        id=1,
        user_id=1,
        name="Fixture",
        icon="*",
        start_date=case.start_date,
        energy_cost=1,
        energy_return=2,
    )
    habit.goals = [
        Goal(
            id=index,
            habit_id=1,
            title=tier,
            tier=tier,
            target=target,
            target_unit="sessions",
            frequency=case.frequency,
            frequency_unit=case.frequency_unit,
            is_additive=case.is_additive,
        )
        for index, (tier, target) in enumerate(case.targets.items(), 1)
    ]
    rows = [
        GoalCompletion(goal_id=2, user_id=1, local_day=day, completed_units=units)
        for day, units in case.completions
    ]
    context = HabitStoryContext(
        today=case.today,
        timezone=case.timezone,
        subtractive=subtractive_context_for_goals(habit.goals, habit.start_date),
        cadence=period_cadence_for_goals(habit.goals, habit.start_date),
    )
    story = build_habit_story(habit, rows, [], context=context)
    assert story.continuity.current_run == case.expected["current"]
    assert story.continuity.longest_run == case.expected["longest"]
