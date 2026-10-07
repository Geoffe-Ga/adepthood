"""Period-counted streaks for weekly / monthly habit cadences (#2819).

A habit whose goals are ``per_week`` or ``per_month`` counts its streak in
consecutive met periods (ISO Monday weeks / calendar months), not days. The
shared parity fixture under ``tests/fixtures/streak_parity`` is evaluated here
through both server owners -- ``GET /habits``'s ``compute_habit_streak`` and
``GET /habits/{id}/stats``'s ``compute_habit_stats`` -- and by the frontend's
``periodStreaks.test.ts``, so client and server cannot drift.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, time
from pathlib import Path
from typing import Any, cast
from zoneinfo import ZoneInfo

import pytest

import domain.dates as dates_module
from domain.habit_stats import compute_habit_stats
from domain.streaks import (
    PeriodCadence,
    PeriodUnit,
    current_consecutive_streak,
    period_current_streak,
    period_longest_streak,
    period_start,
)
from models.goal import Goal
from models.goal_completion import GoalCompletion
from services.streaks import (
    PendingCompletion,
    compute_habit_streak,
    period_cadence_for_goals,
    period_streak_before_and_after,
    subtractive_context_for_goals,
)

_FIXTURE = Path(__file__).resolve().parents[1] / "fixtures/streak_parity/cadence_streaks.json"
_CASES: list[dict[str, Any]] = json.loads(_FIXTURE.read_text(encoding="utf-8"))["cases"]


def _case(prefix: str) -> dict[str, Any]:
    """The one fixture case whose name starts with ``prefix``."""
    [match] = [c for c in _CASES if c["name"].startswith(prefix)]
    return match


_NOON = time(12)
_TIERS = ("low", "clear", "stretch")


def _freeze_today(monkeypatch: pytest.MonkeyPatch, today: date, tz: str) -> None:
    """Pin ``domain.dates.now_in_tz`` to local noon on ``today`` in ``tz``."""
    frozen = datetime.combine(today, _NOON, tzinfo=ZoneInfo(tz))
    monkeypatch.setattr(dates_module, "now_in_tz", lambda _user_or_tz=None: frozen)


def _goals(case: dict[str, Any]) -> list[Goal]:
    """Build the case's three-tier ladder sharing one cadence."""
    return [
        Goal(
            id=index,
            habit_id=1,
            title=tier,
            tier=tier,
            target=case["targets"][tier],
            target_unit="sessions",
            frequency=case["frequency"],
            frequency_unit=case["frequency_unit"],
            is_additive=case["is_additive"],
        )
        for index, tier in enumerate(_TIERS, start=1)
    ]


def _completions(case: dict[str, Any]) -> list[GoalCompletion]:
    """Build the case's completions, all logged against the clear tier."""
    return [
        GoalCompletion(
            goal_id=2,
            user_id=1,
            local_day=date.fromisoformat(day),
            completed_units=units,
            timestamp=datetime.combine(date.fromisoformat(day), _NOON, tzinfo=UTC),
        )
        for day, units in case["completions"]
    ]


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_parity_fixture_through_both_server_owners(
    case: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """``GET /habits`` and ``GET /habits/{id}/stats`` report the fixture's numbers."""
    tz = case["timezone"]
    _freeze_today(monkeypatch, date.fromisoformat(case["today"]), tz)
    goals = _goals(case)
    start = date.fromisoformat(case["start_date"])
    subtractive = subtractive_context_for_goals(goals, start)
    cadence = period_cadence_for_goals(goals, start)
    completions = _completions(case)

    streak = compute_habit_streak(completions, tz, subtractive, cadence)
    stats = compute_habit_stats(completions, tz, subtractive, cadence)

    assert streak == case["expected"]["current"]
    assert stats.current_streak == case["expected"]["current"]
    assert stats.longest_streak == case["expected"]["longest"]


@pytest.mark.parametrize("unit", ["per_day", "per_session"])
def test_day_cadences_have_no_period_cadence(unit: str) -> None:
    """Daily and per-session habits stay on the day-based owner, bit for bit."""
    case = {**_case("weekly additive: two met"), "frequency_unit": unit}
    assert period_cadence_for_goals(_goals(case), date(2026, 1, 1)) is None


def test_no_goals_have_no_period_cadence() -> None:
    """A goal-less habit has no cadence to count in."""
    assert period_cadence_for_goals([], date(2026, 1, 1)) is None


def test_period_target_is_the_clear_tier_target_times_frequency() -> None:
    """The clear tier's ``target * frequency`` is what a period must reach."""
    case = {
        **_case("weekly additive: two met"),
        "targets": {"low": 1, "clear": 2, "stretch": 3},
        "frequency": 3,
    }
    cadence = period_cadence_for_goals(_goals(case), date(2026, 1, 1))
    assert cadence == PeriodCadence(
        unit="per_week", period_target=6, start_date=date(2026, 1, 1), subtractive=False
    )


def test_period_cadence_falls_back_to_the_first_goal_without_a_clear_tier() -> None:
    """With no clear tier the first goal's cadence and target speak for the habit."""
    goals = [g for g in _goals(_case("monthly additive")) if g.tier != "clear"]
    cadence = period_cadence_for_goals(goals, date(2026, 1, 1))
    assert cadence is not None
    assert cadence.unit == "per_month"
    assert (
        cadence.period_target
        == _case("monthly additive")["targets"]["low"] * _case("monthly additive")["frequency"]
    )


def test_daily_owner_is_unchanged_for_daily_habits(monkeypatch: pytest.MonkeyPatch) -> None:
    """A daily habit's streak is exactly the day-based owner's answer."""
    case = _case("daily additive")
    today = date.fromisoformat(case["today"])
    _freeze_today(monkeypatch, today, case["timezone"])
    days = sorted({date.fromisoformat(day) for day, _ in case["completions"]}, reverse=True)
    expected = current_consecutive_streak(days, today)

    assert compute_habit_streak(_completions(case), case["timezone"]) == expected
    assert expected == case["expected"]["current"]


@pytest.mark.parametrize(
    ("day", "unit", "start"),
    [
        (date(2026, 3, 8), "per_week", date(2026, 3, 2)),  # Sunday of a DST week
        (date(2026, 3, 9), "per_week", date(2026, 3, 9)),  # Monday starts a week
        (date(2026, 1, 1), "per_week", date(2025, 12, 29)),  # week spans new year
        (date(2026, 2, 28), "per_month", date(2026, 2, 1)),
        (date(2025, 12, 31), "per_month", date(2025, 12, 1)),
    ],
)
def test_period_start(day: date, unit: str, start: date) -> None:
    """Weeks start on ISO Monday; months on the 1st."""
    assert period_start(day, cast("PeriodUnit", unit)) == start


def _weekly(*, subtractive: bool = False, start: date = date(2026, 3, 2)) -> PeriodCadence:
    """A three-units-per-week cadence for the pure walk tests."""
    return PeriodCadence(
        unit="per_week", period_target=3, start_date=start, subtractive=subtractive
    )


def test_habit_not_started_has_no_period_streak() -> None:
    """A subtractive habit that begins after today has nothing to count."""
    cadence = _weekly(subtractive=True, start=date(2026, 4, 6))
    assert period_current_streak({}, date(2026, 3, 11), cadence) == 0
    assert period_longest_streak({}, date(2026, 3, 11), cadence) == 0


def test_additive_period_walk_reaches_back_before_start_date() -> None:
    """Additive history logged before ``start_date`` still counts, like the day streak."""
    totals = {date(2026, 2, 23): 3.0, date(2026, 3, 2): 3.0}
    cadence = _weekly(start=date(2026, 3, 4))
    assert period_current_streak(totals, date(2026, 3, 11), cadence) == 2
    assert period_longest_streak(totals, date(2026, 3, 11), cadence) == 2


def test_longest_resets_on_an_unmet_closed_period() -> None:
    """A gap week splits two runs; the longer one wins."""
    totals = {
        date(2026, 2, 2): 3.0,
        date(2026, 2, 9): 3.0,
        date(2026, 2, 16): 3.0,
        date(2026, 3, 2): 3.0,
    }
    cadence = _weekly(start=date(2026, 2, 2))
    assert period_longest_streak(totals, date(2026, 3, 11), cadence) == 3
    assert period_current_streak(totals, date(2026, 3, 11), cadence) == 1


def test_streak_before_and_after_folds_the_pending_completion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The third session of the open week turns it met and extends the streak."""
    case = _case("weekly additive: two met")
    _freeze_today(monkeypatch, date.fromisoformat(case["today"]), case["timezone"])
    cadence = period_cadence_for_goals(_goals(case), date.fromisoformat(case["start_date"]))
    assert cadence is not None
    completions = [*_completions(case)]
    completions.append(
        GoalCompletion(goal_id=2, user_id=1, local_day=date(2026, 3, 10), completed_units=1)
    )

    before, after = period_streak_before_and_after(
        completions,
        case["timezone"],
        cadence,
        PendingCompletion(date(2026, 3, 11), 1.0),
    )

    assert (before, after) == (2, 3)
