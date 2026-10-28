"""Whole-person calendars, honest populations and retained-cycle provenance."""

from dataclasses import replace
from datetime import UTC, date, datetime, timedelta

import pytest

from domain.progress_overview import OverviewHabitContext, OverviewInput, build_progress_overview
from domain.streaks import PeriodCadence, PeriodUnit
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.practice_session import PracticeSession
from models.stage_progress import StageProgress

START = date(2026, 1, 5)


def _input(days: int = 1) -> OverviewInput:
    """One anchored, habits-only programme with no fabricated engagement."""
    return OverviewInput(
        today=START + timedelta(days=days - 1),
        timezone="UTC",
        progress=StageProgress(
            user_id=1, current_stage=1, program_started_at=datetime(2026, 1, 5, tzinfo=UTC)
        ),
        enable_practices=False,
    )


def _habit(identifier: int = 1, *, start: date = START) -> Habit:
    """A retained habit with a canonical colour stage and positive energy."""
    return Habit(
        id=identifier,
        user_id=1,
        name=f"Habit {identifier}",
        icon="pen",
        start_date=start,
        stage="Blue",
        energy_cost=2,
        energy_return=5,
    )


def _goal(identifier: int = 1, *, tier: str = "low", target: float = 2) -> Goal:
    """One named daily tier; callers can exercise old incomplete ladders."""
    return Goal(
        id=identifier,
        habit_id=1,
        title=tier,
        tier=tier,
        target=target,
        target_unit="pages",
        frequency=1,
        frequency_unit="per_day",
    )


def _completion(day: date, units: float = 2, goal_id: int = 1) -> GoalCompletion:
    """Immutable local calendar identity deliberately distinct from audit time."""
    return GoalCompletion(
        goal_id=goal_id,
        user_id=1,
        local_day=day,
        timestamp=datetime(2030, 1, 1, tzinfo=UTC),
        completed_units=units,
    )


def test_unknown_anchor_keeps_dates_unknown_and_read_only() -> None:
    """Neither legacy stage timestamps nor habits stand in for a missing anchor."""
    data = replace(_input(), progress=None, habits=[_habit()])
    result = build_progress_overview(data)
    assert result.arc.program_started_at is None
    assert result.rhythm.days == []
    assert all(stage.opens_on is None for stage in result.arc.stages)
    assert result.arc.habit_births[0].week is None
    assert not result.arc.habit_births[0].is_carryover
    assert len(result.energy.weeks) == 12


def test_arc_uses_ten_native_durations_and_canonical_birth_stage() -> None:
    """Week23 remains inside Teal; birth labels use colour identity."""
    data = replace(_input(155), habits=[_habit()], aspects={4: "Community"}, practice_asks={4: 15})
    result = build_progress_overview(data)
    assert result.arc.current_week == 23
    assert [stage.weeks for stage in result.arc.stages] == [3] * 8 + [6, 6]
    assert result.arc.stages[3].aspect == "Community"
    assert result.arc.stages[3].practice_ask_minutes == 15
    assert result.arc.stages[-1].opens_on == START + timedelta(weeks=30)
    assert result.arc.habit_births[0].stage_number == 4
    assert result.arc.habit_births[0].week == 1


@pytest.mark.parametrize(("offset", "week"), [(251, 36), (252, None), (294, None)])
def test_births_outside_the_ribbon_keep_their_names_without_a_false_boundary_week(
    offset: int, week: int | None
) -> None:
    """A traveller can stay in a live cycle after its thirty-six-week arc ends."""
    habit = _habit(start=START + timedelta(days=offset))
    arc = build_progress_overview(replace(_input(301), habits=[habit])).arc
    assert arc.current_week == 36
    assert len(arc.habit_births) == 1
    assert arc.habit_births[0].name == habit.name
    assert arc.habit_births[0].week == week
    assert not arc.habit_births[0].is_carryover


def test_a_future_birth_stays_absent_even_when_it_would_be_outside_the_ribbon() -> None:
    """Withholding future facts is distinct from retaining actual unplaced births."""
    habit = _habit(start=START + timedelta(days=252))
    assert build_progress_overview(replace(_input(252), habits=[habit])).arc.habit_births == []


@pytest.mark.parametrize(
    ("offset", "stored", "expected"),
    [(-1, False, True), (0, False, False), (1, False, False), (0, True, True)],
)
def test_carryover_is_current_cycle_provenance(offset: int, stored: bool, expected: bool) -> None:
    """Retained prior-cycle habits remain visible without changing their stored flag."""
    habit = _habit(start=START + timedelta(days=offset))
    habit.is_carryover = stored
    birth = build_progress_overview(replace(_input(3), habits=[habit])).arc.habit_births[0]
    assert birth.is_carryover is expected
    assert (birth.week is None) is expected
    assert habit.is_carryover is stored


def test_carryover_boundary_is_user_local() -> None:
    """A UTC anchor late at night is still the prior local day in Los Angeles."""
    data = replace(
        _input(), timezone="America/Los_Angeles", habits=[_habit(start=date(2026, 1, 4))]
    )
    assert not build_progress_overview(data).arc.habit_births[0].is_carryover


@pytest.mark.parametrize("stored", [False, True])
def test_legacy_null_anchor_does_not_infer_dates_or_carryover(stored: bool) -> None:
    """A stage-start timestamp cannot replace the destroyed programme anchor."""
    data = _input()
    assert data.progress is not None
    data.progress.program_started_at = None
    habit = _habit(start=START - timedelta(days=100))
    habit.is_carryover = stored
    result = build_progress_overview(replace(data, habits=[habit]))
    assert result.arc.program_started_at is None
    assert result.arc.current_week is None
    assert result.arc.habit_births[0].week is None
    assert result.arc.habit_births[0].is_carryover is stored
    assert result.rhythm.days == []


def test_scheduled_days_and_mean_of_daily_fractions_have_raw_denominators() -> None:
    """The rolling mean is not a ratio of pooled habit opportunities."""
    first, second = _habit(), _habit(2)
    first.notification_days = ["Mon", "Wed", "Fri"]
    second.start_date = START + timedelta(days=1)
    goal = _goal(2)
    goal.habit_id = 2
    data = replace(
        _input(2), habits=[first, second], goals=[_goal(), goal], completions=[_completion(START)]
    )
    days = build_progress_overview(data).rhythm.days
    assert [(day.daily_met, day.daily_scheduled, day.window_days) for day in days] == [
        (1, 1, 1),
        (0, 1, 2),
    ]
    assert [day.rate for day in days] == [1, 0.5]


def test_rolling_window_drops_old_values_and_fullest_requires_fourteen_days() -> None:
    """Partial opening windows cannot claim the fullest fortnight."""
    data = replace(_input(15), habits=[_habit()], goals=[_goal()], completions=[_completion(START)])
    result = build_progress_overview(data)
    assert result.rhythm.days[-1].rate == 0
    assert result.rhythm.days[-1].window_days == 14
    assert result.rhythm.fullest_fortnight_ending == START + timedelta(days=13)
    assert (
        build_progress_overview(replace(data, today=START)).rhythm.fullest_fortnight_ending is None
    )


def test_practice_counts_positive_partial_once_per_local_day() -> None:
    """Two positive sits count once and a zero abort never fills a day."""
    rows = [
        PracticeSession(
            user_id=1,
            user_practice_id=1,
            duration_minutes=n,
            completed=False,
            timestamp=datetime(2026, 1, 5, 1, tzinfo=UTC),
        )
        for n in [0, 2, 4]
    ]
    data = replace(
        _input(),
        timezone="America/Los_Angeles",
        enable_practices=True,
        practice_sessions=rows,
        today=date(2026, 1, 4),
    )
    day = build_progress_overview(data).rhythm.days[0]
    assert (day.daily_met, day.daily_scheduled, day.rate) == (1, 1, 1)
    assert (
        build_progress_overview(replace(data, practice_sessions=rows[:1])).rhythm.days[0].rate == 0
    )


def test_disabled_rings_contribute_no_populations() -> None:
    """Both toggles control numerator and denominator together."""
    data = replace(
        _input(),
        enable_habits=False,
        habits=[_habit()],
        goals=[_goal()],
        completions=[_completion(START)],
    )
    result = build_progress_overview(data)
    assert result.rhythm.days[0].daily_scheduled == 0
    assert result.rhythm.days[0].rate == 0
    assert result.arc.habit_births == []
    assert all(week.net == 0 for week in result.energy.weeks)


@pytest.mark.parametrize("subtractive", [False, True])
@pytest.mark.parametrize("unit", ["per_week", "per_month"])
@pytest.mark.parametrize("units", [3, 5])
def test_periods_use_whole_native_total_and_each_tiers_own_target(
    unit: PeriodUnit, subtractive: bool, units: int
) -> None:
    """Daily grid observations mirror the containing period's outcome."""
    low = _goal()
    clear = _goal(2, tier="clear", target=1 if subtractive else 3)
    for goal in [low, clear]:
        goal.frequency_unit, goal.frequency, goal.is_additive = unit, 2, not subtractive
    cadence = PeriodCadence(
        unit=unit,
        period_target=clear.target * clear.frequency,
        start_date=START,
        subtractive=subtractive,
    )
    data = replace(
        _input(3),
        habits=[_habit()],
        goals=[low, clear],
        completions=[_completion(START, 2), _completion(START + timedelta(days=2), units - 2)],
        habit_contexts={1: OverviewHabitContext(cadence=cadence, subtractive=subtractive)},
    )
    days = build_progress_overview(data).rhythm.days
    expected = units <= 4 if subtractive else units >= 4
    assert [day.daily_met for day in days] == [int(expected)] * 3


def test_daily_polarity_is_habit_wide_not_selected_tier() -> None:
    """An additive Low can belong to a legacy subtractive ladder."""
    data = replace(
        _input(2),
        habits=[_habit()],
        goals=[_goal()],
        completions=[_completion(START, 3)],
        habit_contexts={1: OverviewHabitContext(subtractive=True)},
    )
    assert [day.daily_met for day in build_progress_overview(data).rhythm.days] == [0, 1]


@pytest.mark.parametrize("tiers", [["clear", "stretch"], ["stretch"]])
def test_incomplete_named_ladders_use_clear_then_stretch(tiers: list[str]) -> None:
    """Valid legacy ladders without Low still have a deterministic minimum."""
    goals = [_goal(index + 1, tier=tier) for index, tier in enumerate(tiers)]
    data = replace(
        _input(),
        habits=[_habit()],
        goals=list(reversed(goals)),
        completions=[_completion(START, goal_id=1)],
    )
    assert build_progress_overview(data).rhythm.days[0].daily_met == 1


@pytest.mark.parametrize("met", [False, True])
def test_flat_wave_has_no_rising_claim(met: bool) -> None:
    """A monotone flat line alone is no evidence of an increase."""
    rows = [_completion(START + timedelta(days=n)) for n in range(35)] if met else []
    result = build_progress_overview(
        replace(_input(35), habits=[_habit()], goals=[_goal()], completions=rows)
    )
    assert result.rhythm.rising_since is None


def test_rise_requires_seven_days_and_an_actual_increase() -> None:
    """The current nondecreasing stretch can include a quiet opening."""
    data = replace(
        _input(7),
        habits=[_habit()],
        goals=[_goal()],
        completions=[_completion(START + timedelta(days=6))],
    )
    assert build_progress_overview(data).rhythm.rising_since == START
    assert (
        build_progress_overview(replace(data, today=START + timedelta(days=5))).rhythm.rising_since
        is None
    )


def test_rest_excludes_first_four_weeks_and_rhythm_caps_at_one_cycle() -> None:
    """Rest is factual only after day28; the live cycle has252 calendar slots."""
    result = build_progress_overview(_input(300))
    assert len(result.rhythm.days) == 252
    assert result.arc.current_week == 36
    assert result.rhythm.longest_rest is not None
    assert result.rhythm.longest_rest.start == START + timedelta(days=28)
    assert result.rhythm.longest_rest.end == START + timedelta(days=251)


def test_unknown_past_anchor_is_omitted_without_guessing() -> None:
    """The second retained cycle is known even though the first was destroyed."""
    data = _input(2)
    assert data.progress is not None
    data.progress.cycle_number = 3
    data.progress.program_started_at = datetime(2026, 9, 14, tzinfo=UTC)
    data.progress.past_cycle_anchors = [None, "2026-01-05T00:00:00+00:00"]
    data = replace(data, today=date(2026, 9, 15))
    result = build_progress_overview(data)
    assert len(result.cycles) == 10
    assert {rate.cycle for stage in result.cycles for rate in stage.rates} == {2, 3}
    assert result.cycles[0].rates[-1].scheduled_days == 0
    assert build_progress_overview(_input()).cycles == []


def test_cycle_population_matches_rhythm_and_clamps_successor_midnight() -> None:
    """No scheduled opportunity leaks across a retained cycle boundary."""
    data = replace(
        _input(2),
        habits=[_habit()],
        goals=[_goal()],
        completions=[_completion(START)],
        enable_practices=True,
    )
    assert data.progress is not None
    data.progress.cycle_number = 2
    data.progress.past_cycle_anchors = ["2025-12-15T00:00:00+00:00"]
    rates = build_progress_overview(data).cycles[0].rates
    assert (rates[0].met_days, rates[0].scheduled_days) == (0, 21)
    rate = rates[-1]
    assert (rate.met_days, rate.scheduled_days) == (1, 4)
    assert rate.rate == 0.25


def test_energy_uses_persisted_days_positive_rows_and_twelve_mondays() -> None:
    """Zero rows and future identities cannot create a completion's energy."""
    data = replace(
        _input(10),
        habits=[_habit()],
        goals=[_goal()],
        completions=[
            _completion(START),
            _completion(START + timedelta(days=1), 0),
            _completion(START + timedelta(days=20)),
        ],
    )
    result = build_progress_overview(data).energy
    assert len(result.weeks) == 12
    assert all(week.week_start.weekday() == 0 for week in result.weeks)
    assert sum(week.net for week in result.weeks) == 3
    assert result.formula == "sum(return - cost) over completions"


def test_energy_retains_negative_net_values() -> None:
    """A completion can consume net energy without losing its ledger column."""
    habit = _habit()
    habit.energy_cost, habit.energy_return = 10, 2
    data = replace(_input(), habits=[habit], goals=[_goal()], completions=[_completion(START)])
    assert build_progress_overview(data).energy.weeks[-1].net == -8
