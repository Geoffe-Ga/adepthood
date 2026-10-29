"""Whole-person calendars, honest populations and retained-cycle provenance."""

from dataclasses import replace
from datetime import UTC, date, datetime, timedelta

import pytest

from domain.progress_overview import OverviewHabitContext, OverviewInput, build_progress_overview
from domain.streaks import PeriodCadence
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


def _habit(identifier: int = 1, *, start: date = START, stage: str = "Beige") -> Habit:
    """An unlocked habit on the first stage, open from the anchor, with positive energy."""
    return Habit(
        id=identifier,
        user_id=1,
        name=f"Habit {identifier}",
        icon="pen",
        start_date=start,
        stage=stage,
        energy_cost=2,
        energy_return=5,
        revealed=True,
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
    """Week23 remains inside Teal; a Blue habit is born when Blue opens, in week ten."""
    data = replace(
        _input(155),
        habits=[_habit(stage="Blue")],
        aspects={4: "Community"},
        practice_asks={4: 15},
    )
    result = build_progress_overview(data)
    assert result.arc.current_week == 23
    assert [stage.weeks for stage in result.arc.stages] == [3] * 8 + [6, 6]
    assert result.arc.stages[3].aspect == "Community"
    assert result.arc.stages[3].practice_ask_minutes == 15
    assert result.arc.stages[-1].opens_on == START + timedelta(weeks=30)
    assert result.arc.habit_births[0].stage_number == 4
    assert result.arc.habit_births[0].week == 10


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
    [(-1, False, False), (0, False, False), (1, False, False), (0, True, True)],
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


def test_rate_pools_the_trailing_week_of_scheduled_asks() -> None:
    """The wave is kept asks over scheduled asks, both carried for the client."""
    first, second = _habit(), _habit(2)
    first.notification_days = ["Mon", "Wed", "Fri"]
    second.start_date = START + timedelta(days=1)
    goal = _goal(2)
    goal.habit_id = 2
    data = replace(
        _input(2), habits=[first, second], goals=[_goal(), goal], completions=[_completion(START)]
    )
    days = build_progress_overview(data).rhythm.days
    assert [
        (day.daily_met, day.daily_scheduled, day.window_met, day.window_scheduled, day.window_days)
        for day in days
    ] == [(1, 1, 1, 1, 1), (0, 1, 1, 2, 2)]
    assert [day.rate for day in days] == [1, 0.5]


def test_rolling_window_is_seven_days_and_fullest_requires_a_whole_week() -> None:
    """Partial opening windows cannot claim the fullest week."""
    data = replace(_input(8), habits=[_habit()], goals=[_goal()], completions=[_completion(START)])
    result = build_progress_overview(data)
    last = result.rhythm.days[-1]
    assert (last.rate, last.window_days, last.window_met, last.window_scheduled) == (0, 7, 0, 7)
    assert result.rhythm.days[-2].window_met == 1
    assert result.rhythm.fullest_week_ending == START + timedelta(days=6)
    assert build_progress_overview(replace(data, today=START)).rhythm.fullest_week_ending is None


def test_a_locked_habit_is_never_scheduled() -> None:
    """Twelve seeded habits are not twelve asks: only the unlocked ones are."""
    locked = _habit(2)
    locked.revealed = False
    goal = _goal(2)
    goal.habit_id = 2
    data = replace(_input(), habits=[_habit(), locked], goals=[_goal(), goal])
    assert build_progress_overview(data).rhythm.days[0].daily_scheduled == 1


def test_a_laddered_habit_joins_when_its_stage_opens_not_at_a_stale_start_date() -> None:
    """A template start date long before the anchor cannot make day one ask for it."""
    habit = _habit(start=date(2025, 4, 1), stage="Purple")
    data = replace(_input(23), habits=[habit], goals=[_goal()])
    days = build_progress_overview(data).rhythm.days
    assert [day.daily_scheduled for day in days] == [0] * 21 + [1, 1]
    assert build_progress_overview(data).arc.habit_births[0].week == 4


@pytest.mark.parametrize("early", ["unlocked", "logged"])
def test_unlocking_or_logging_before_the_stage_opens_joins_that_day(early: str) -> None:
    """The person may take a later habit on sooner than the ladder offers it."""
    habit = _habit(start=date(2025, 4, 1), stage="Purple")
    rows = []
    if early == "unlocked":
        habit.auto_revealed_at = datetime(2026, 1, 9, 12, tzinfo=UTC)
    else:
        rows = [_completion(START + timedelta(days=4))]
    data = replace(_input(6), habits=[habit], goals=[_goal()], completions=rows)
    days = build_progress_overview(data).rhythm.days
    assert [day.daily_scheduled for day in days] == [0, 0, 0, 0, 1, 1]
    assert build_progress_overview(data).arc.habit_births[0].week == 1


def _weekly(target: float = 9, frequency: float = 2) -> Goal:
    """Lifting: nine sets, twice a week."""
    goal = _goal(target=target)
    goal.target_unit, goal.frequency, goal.frequency_unit = "sets", frequency, "per_week"
    return goal


def _weekly_context(*, subtractive: bool = False) -> dict[int, OverviewHabitContext]:
    """The canonical weekly cadence the router derives for habit 1."""
    cadence = PeriodCadence(
        unit="per_week", period_target=18, start_date=START, subtractive=subtractive
    )
    return {1: OverviewHabitContext(cadence=cadence, subtractive=subtractive)}


def test_a_twice_weekly_habit_asks_twice_a_week_not_every_day() -> None:
    """Each kept occasion counts on its day; the shortfall lands on a finished Sunday."""
    rows = [_completion(START + timedelta(days=1), 9), _completion(START + timedelta(days=8), 9)]
    data = replace(
        _input(15),
        habits=[_habit()],
        goals=[_weekly()],
        completions=rows,
        habit_contexts=_weekly_context(),
    )
    days = build_progress_overview(data).rhythm.days
    pairs = [(day.daily_met, day.daily_scheduled) for day in days]
    assert pairs[1] == pairs[8] == (1, 1)
    assert pairs[6] == pairs[13] == (0, 1)
    assert sum(pair[1] for pair in pairs) == 4
    assert days[-1].window_scheduled == 2


def test_a_big_day_keeps_one_occasion_and_a_short_day_keeps_none() -> None:
    """An occasion is a day at Low; logging three sessions' worth is still one day."""
    rows = [
        _completion(START, 8),
        _completion(START + timedelta(days=1), 27),
    ]
    data = replace(
        _input(8),
        habits=[_habit()],
        goals=[_weekly()],
        completions=rows,
        habit_contexts=_weekly_context(),
    )
    pairs = [
        (day.daily_met, day.daily_scheduled) for day in build_progress_overview(data).rhythm.days
    ]
    assert pairs[:2] == [(0, 0), (1, 1)]
    assert pairs[6] == (0, 1)


def test_the_current_week_has_no_shortfall_until_it_is_over() -> None:
    """On Sunday itself there is still time; the ask lands on Monday's read."""
    data = replace(
        _input(7), habits=[_habit()], goals=[_weekly()], habit_contexts=_weekly_context()
    )
    assert build_progress_overview(data).rhythm.days[-1].daily_scheduled == 0
    later = build_progress_overview(replace(data, today=START + timedelta(days=7)))
    assert later.rhythm.days[6].daily_scheduled == 2
    mixed = _weekly(frequency=3)
    mixed.frequency_unit = "per_day"
    daily_low = replace(data, goals=[mixed], today=START + timedelta(days=7))
    assert build_progress_overview(daily_low).rhythm.days[6].daily_scheduled == 1


@pytest.mark.parametrize(("units", "met"), [(3, 1), (40, 0)])
def test_a_weekly_limit_is_one_ask_judged_when_the_week_ends(units: float, met: int) -> None:
    """A subtractive week is kept when its total stays within any named tier."""
    goal = _weekly(target=2, frequency=2)
    goal.is_additive = False
    data = replace(
        _input(8),
        habits=[_habit()],
        goals=[goal],
        completions=[_completion(START + timedelta(days=2), units)],
        habit_contexts=_weekly_context(subtractive=True),
    )
    pairs = [
        (day.daily_met, day.daily_scheduled) for day in build_progress_overview(data).rhythm.days
    ]
    assert pairs[6] == (met, 1)
    assert sum(pair[1] for pair in pairs) == 1


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


def test_rhythm_caps_at_one_cycle_and_an_empty_account_names_no_rest() -> None:
    """The live cycle has 252 calendar slots; with nothing ever asked, no day was a rest."""
    result = build_progress_overview(_input(300))
    assert len(result.rhythm.days) == 252
    assert result.arc.current_week == 36
    assert result.rhythm.longest_rest is None
    assert not any("rested" in sentence for sentence in result.observations)


def test_no_rest_is_named_before_the_first_habit_began() -> None:
    """Weeks before any habit existed had nothing to keep, so they are not a rest."""
    begun = START + timedelta(days=100)
    rows = [_completion(begun + timedelta(days=n)) for n in range(60)]
    result = build_progress_overview(
        replace(_input(160), habits=[_habit(start=begun)], goals=[_goal()], completions=rows)
    )
    assert result.rhythm.longest_rest is None


def test_a_quiet_stretch_after_the_opening_weeks_is_a_rest() -> None:
    """A habit kept daily, then left for three weeks, rests inside those weeks only."""
    quiet = range(40, 61)
    rows = [_completion(START + timedelta(days=n)) for n in range(90) if n not in quiet]
    rest = build_progress_overview(
        replace(_input(90), habits=[_habit()], goals=[_goal()], completions=rows)
    ).rhythm.longest_rest
    assert rest is not None
    assert START + timedelta(days=40) <= rest.start
    # The trailing week still reads quiet on the first day back, then lifts.
    assert rest.end == START + timedelta(days=61)


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


def test_overview_words_its_rhythm_facts_as_one_caption() -> None:
    """The wave's caption (#3525) is built from the same three facts it carries."""
    quiet = range(40, 61)
    rows = [_completion(START + timedelta(days=n)) for n in range(90) if n not in quiet]
    result = build_progress_overview(
        replace(_input(90), habits=[_habit()], goals=[_goal()], completions=rows)
    )
    assert result.observations == [
        (
            "Your fullest week was mid January. You rested from 19 February to 7 March."
            " You have been rising since 20 February."
        )
    ]


def test_a_kept_week_is_named_in_the_caption() -> None:
    """Once the wave rises, its fullest week leads the caption."""
    rows = [_completion(START + timedelta(days=n)) for n in range(14)]
    result = build_progress_overview(
        replace(_input(30), habits=[_habit()], goals=[_goal()], completions=rows)
    )
    assert result.observations[0].startswith("Your fullest week was mid January.")


def test_an_early_overview_says_when_the_rhythm_appears() -> None:
    """Before four weeks the caption says the wave is still taking shape."""
    assert build_progress_overview(_input(3)).observations == [
        "Your rhythm takes shape after four weeks of days."
    ]


def test_program_habit_at_zero_offset_is_week_one_beige_not_brought_along() -> None:
    """Programme rows preceding a reconciled anchor still belong to the first stage."""
    habit = _habit(start=START - timedelta(days=1))
    habit.stage = "0"
    birth = build_progress_overview(replace(_input(4), habits=[habit])).arc.habit_births[0]
    assert not birth.is_carryover
    assert birth.week == 1
    assert birth.stage_number == 1


def test_habit_history_uses_daily_logged_units_and_keeps_measures_separate() -> None:
    """Tiers share units, while unlike measures must never be summed together."""
    clear, minutes = _goal(2, tier="clear"), _goal(3, tier="stretch")
    minutes.target_unit = "minutes"
    data = replace(
        _input(4),
        habits=[_habit()],
        goals=[_goal(), clear, minutes],
        completions=[
            _completion(START, 2),
            _completion(START, 3, goal_id=2),
            _completion(START + timedelta(days=2), 1.5),
            _completion(START, 10, goal_id=3),
            _completion(START - timedelta(days=1), 50),
            _completion(START + timedelta(days=4), 50),
            _completion(START, 50, goal_id=99),
        ],
    )
    histories = build_progress_overview(data).arc.habit_births[0].unit_histories
    assert [history.unit for history in histories] == ["pages", "minutes"]
    assert [day.units for day in histories[0].days] == [5, 0, 1.5, 0]
    assert [day.units for day in histories[1].days] == [10, 0, 0, 0]
    assert histories[0].days[2].date == START + timedelta(days=2)
    assert (
        build_progress_overview(replace(data, progress=None)).arc.habit_births[0].unit_histories
        == []
    )
    assert build_progress_overview(replace(data, enable_habits=False)).arc.habit_births == []


@pytest.mark.parametrize(("offset", "stage"), [(0, 1), (20, 1), (21, 2), (168, 9), (210, 10)])
def test_unknown_adoption_stage_falls_back_to_the_programme_date(offset: int, stage: int) -> None:
    """Missing stage labels can still use a known date within the programme."""
    habit = _habit(start=START + timedelta(days=offset))
    habit.stage = ""
    birth = build_progress_overview(replace(_input(252), habits=[habit])).arc.habit_births[0]
    assert birth.stage_number == stage


def test_unit_history_stops_at_the_programme_boundary_and_keeps_explicit_carryovers() -> None:
    """Carryovers have histories too; neither series extends beyond this pass."""
    habit = _habit(start=START - timedelta(days=20))
    habit.is_carryover = True
    data = replace(
        _input(300),
        habits=[habit],
        goals=[_goal()],
        completions=[
            _completion(START + timedelta(days=251), 3),
            _completion(START + timedelta(days=252), 50),
        ],
    )
    birth = build_progress_overview(data).arc.habit_births[0]
    assert birth.is_carryover
    history = birth.unit_histories[0]
    assert len(history.days) == 252
    assert history.days[-1].units == 3
    assert sum(day.units for day in history.days) == 3


def test_recorded_adoption_stage_survives_an_offset_programme_anchor() -> None:
    """A Purple habit dated week three joins when Purple opens, in week four."""
    habit = _habit(start=START + timedelta(weeks=2), stage="Purple")
    birth = build_progress_overview(replace(_input(30), habits=[habit])).arc.habit_births[0]
    assert birth.week == 4
    assert birth.stage_number == 2


def test_unit_history_carries_a_seven_day_average_and_omits_unlogged_measures() -> None:
    """Spiky days are smoothed beside the raw amount; an unused measure is not drawn."""
    unused = _goal(2, tier="clear")
    unused.target_unit = "reps"
    data = replace(
        _input(9),
        habits=[_habit()],
        goals=[_goal(), unused],
        completions=[_completion(START, 7), _completion(START + timedelta(days=7), 14)],
    )
    histories = build_progress_overview(data).arc.habit_births[0].unit_histories
    assert [history.unit for history in histories] == ["pages"]
    days = histories[0].days
    assert [day.units for day in days[:2]] == [7, 0]
    assert days[0].average == 7
    assert days[1].average == 3.5
    assert days[6].average == 1
    assert days[7].average == 2
    assert days[8].average == 2


def test_no_rise_is_dated_before_the_first_habit_began() -> None:
    """Empty weeks before a habit existed are not the floor of a rise."""
    begun = START + timedelta(days=20)
    rows = [_completion(begun + timedelta(days=n)) for n in range(21)]
    result = build_progress_overview(
        replace(_input(41), habits=[_habit(start=begun)], goals=[_goal()], completions=rows)
    )
    assert result.rhythm.rising_since is None
