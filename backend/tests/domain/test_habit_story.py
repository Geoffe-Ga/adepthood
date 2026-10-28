"""Habit Story describes density without inventing recorded history."""

from datetime import UTC, date, datetime

import pytest

from domain import streaks
from domain.habit_story import build_habit_story
from domain.habit_story_types import GoalLogFact, HabitStoryContext
from domain.streaks import PeriodCadence, SubtractiveContext
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit


def _habit(*, start: date = date(2026, 6, 1), subtractive: bool = False) -> Habit:
    habit = Habit(
        id=1,
        user_id=1,
        name="Pages",
        icon="*",
        start_date=start,
        energy_cost=1,
        energy_return=2,
    )
    habit.goals = [
        Goal(
            id=index,
            habit_id=1,
            title=tier,
            tier=tier,
            target=amount,
            target_unit="pages",
            frequency=1,
            frequency_unit="per_day",
            is_additive=not subtractive,
        )
        for index, (tier, amount) in enumerate((("low", 1), ("clear", 2), ("stretch", 3)), 1)
    ]
    return habit


def _row(day: int, units: float) -> GoalCompletion:
    return GoalCompletion(goal_id=2, user_id=1, local_day=date(2026, 6, day), completed_units=units)


def test_schedule_denominators_and_under_logs_are_explicit() -> None:
    """A kept Mon/Wed/Fri cadence has a scheduled denominator of three."""
    habit = _habit()
    habit.notification_days = ["Mon", "Wed", "Fri"]
    story = build_habit_story(
        habit,
        [_row(1, 1), _row(3, 2), _row(5, 3), _row(2, 0.5)],
        [],
        context=HabitStoryContext(today=date(2026, 6, 7)),
    )
    assert story.rates.all_time.met == story.rates.all_time.scheduled == 3
    assert story.logged_days == 4
    assert story.continuity.days_with == 3
    assert story.tiers.totals.model_dump() == {
        "low": 1,
        "clear": 1,
        "stretch": 1,
        "under": 1,
        "quiet": 0,
    }
    assert story.days[1].scheduled is False
    assert story.days[1].logged is True


def test_legacy_and_signed_events_preserve_unknown_residual() -> None:
    """Legacy64 plus timed32 and undo8 is timed24 plus unknown64."""
    logs = [
        GoalLogFact(
            id=index,
            timestamp=datetime(2026, 6, 2, 6, 30, tzinfo=UTC),
            local_day=date(2026, 6, 1),
            delta_units=units,
            via_timer=False,
            source="manual",
        )
        for index, units in enumerate((32, -8), 1)
    ]
    story = build_habit_story(
        _habit(),
        [_row(1, 88)],
        logs,
        context=HabitStoryContext(today=date(2026, 6, 2), timezone="America/Los_Angeles"),
    )
    assert story.days[0].unknown_time_units == 64
    assert story.patterns.unknown_time_units == 64
    assert story.patterns.weekday_by_time_of_day[0][3] == 24
    assert story.patterns.time_of_day_available_since == date(2026, 6, 1)
    assert story.log_count == 2
    assert [log.delta_units for log in story.logs] == [-8, 32]


def test_zero_rows_populate_days_without_inventing_events() -> None:
    """An empty additive habit has a complete quiet calendar and honest timing."""
    story = build_habit_story(_habit(), [], [], context=HabitStoryContext(today=date(2026, 6, 3)))
    assert len(story.days) == 3
    assert story.logged_days == story.log_count == story.continuity.days_with == 0
    assert story.tiers.totals.quiet == 3
    assert story.patterns.time_of_day_available_since is None
    assert story.observations == []
    assert story.milestones == []


def test_period_days_use_whole_period_outcome_and_native_rates() -> None:
    """Daily cells retain amounts while the completed week supplies their tier."""
    habit = _habit()
    for goal in habit.goals:
        goal.frequency_unit = "per_week"
        goal.frequency = 2
    story = build_habit_story(
        habit,
        [_row(1, 1), _row(3, 3)],
        [],
        context=HabitStoryContext(
            today=date(2026, 6, 7), cadence=PeriodCadence("per_week", 4, habit.start_date, False)
        ),
    )
    assert story.days[0].units == 1
    assert story.days[0].tier == story.days[2].tier == "clear"
    assert story.continuity.days_with == story.rates.all_time.met == 1
    assert story.rates.all_time.scheduled == 1
    assert story.rates.unit == story.continuity.unit == "weeks"


def test_a_delayed_first_met_day_is_not_a_return() -> None:
    """Coming back requires a prior met day, even when adoption began with quiet days."""
    story = build_habit_story(
        _habit(),
        [_row(3, 2), _row(5, 2)],
        [],
        context=HabitStoryContext(today=date(2026, 6, 5)),
    )
    assert story.continuity.returns == 1


def test_a_delayed_first_met_period_is_not_a_return() -> None:
    """Quiet weeks before the first successful week do not imply an earlier practice."""
    habit = _habit()
    for goal in habit.goals:
        goal.frequency_unit = "per_week"
    story = build_habit_story(
        habit,
        [_row(15, 2)],
        [],
        context=HabitStoryContext(
            today=date(2026, 6, 21), cadence=PeriodCadence("per_week", 2, habit.start_date, False)
        ),
    )
    assert story.continuity.returns == 0


def test_first_within_limit_after_initial_transgression_is_not_a_return() -> None:
    """Subtractive returns also require an earlier within-limit native unit."""
    habit = _habit(subtractive=True)
    story = build_habit_story(
        habit,
        [_row(1, 4)],
        [],
        context=HabitStoryContext(
            today=date(2026, 6, 3), subtractive=SubtractiveContext(2, habit.start_date)
        ),
    )
    assert story.continuity.returns == 0


def test_recorded_prestart_days_count_lifetime_without_expanding_rates() -> None:
    """Reset dates constrain denominators, while actual earlier facts still count."""
    habit = _habit(start=date(2026, 6, 3))
    story = build_habit_story(
        habit,
        [_row(1, 2), _row(3, 2)],
        [],
        context=HabitStoryContext(today=date(2026, 6, 3)),
    )
    assert story.continuity.days_with == 2
    assert story.rates.all_time.met == story.rates.all_time.scheduled == 1
    assert story.days[0].scheduled is False
    assert story.days[0].met is True


def test_prestart_subtractive_rows_never_invent_abstention() -> None:
    """Only real prestart zero rows count before the habit existed."""
    habit = _habit(start=date(2026, 6, 5), subtractive=True)
    for goal, limit in zip(habit.goals, (3, 2, 1), strict=True):
        goal.target = limit
    story = build_habit_story(
        habit,
        [_row(1, 0)],
        [],
        context=HabitStoryContext(
            today=date(2026, 6, 5), subtractive=SubtractiveContext(2, habit.start_date)
        ),
    )
    assert story.continuity.days_with == 2
    assert story.rates.all_time.met == story.rates.all_time.scheduled == 1
    assert [day.met for day in story.days] == [True, False, False, False, True]


def test_prestart_period_records_are_deduplicated_without_phantom_weeks() -> None:
    """Two recorded days in an earlier met week add one lifetime native unit."""
    habit = _habit(start=date(2026, 6, 17))
    for goal in habit.goals:
        goal.frequency_unit = "per_week"
    story = build_habit_story(
        habit,
        [_row(1, 2), _row(2, 1)],
        [],
        context=HabitStoryContext(
            today=date(2026, 6, 17), cadence=PeriodCadence("per_week", 2, habit.start_date, False)
        ),
    )
    assert story.continuity.days_with == 1
    assert story.rates.all_time.met == 0
    assert story.rates.all_time.scheduled == 1


def test_subtractive_prestart_period_zero_is_real_but_missing_week_is_not() -> None:
    """A historical zero counts once; absent prestart periods never count as wins."""
    habit = _habit(start=date(2026, 6, 17), subtractive=True)
    story = build_habit_story(
        habit,
        [_row(1, 0), _row(2, 0)],
        [],
        context=HabitStoryContext(
            today=date(2026, 6, 17),
            subtractive=SubtractiveContext(2, habit.start_date),
            cadence=PeriodCadence("per_week", 2, habit.start_date, True),
        ),
    )
    assert story.continuity.days_with == 2
    assert story.rates.all_time.met == story.rates.all_time.scheduled == 1


def test_returns_skip_unscheduled_days_and_do_not_count_first_use() -> None:
    """A return follows a missed scheduled day, regardless of intervening rests."""
    habit = _habit()
    habit.notification_days = ["Mon", "Wed", "Fri"]
    story = build_habit_story(
        habit,
        [_row(1, 2), _row(5, 2), _row(8, 2)],
        [],
        context=HabitStoryContext(today=date(2026, 6, 8)),
    )
    assert story.continuity.returns == 1
    assert story.rates.all_time.met == 3
    assert story.rates.all_time.scheduled == 4


def test_stage_boundaries_use_real_anchor_and_carryover_has_none() -> None:
    """A partial series intersects stage bounds without moving their actual dates."""
    habit = _habit(start=date(2026, 6, 3))
    context = HabitStoryContext(today=date(2026, 6, 25), program_started_on=date(2026, 6, 1))
    story = build_habit_story(habit, [], [], context=context)
    assert [(stage.stage_number, stage.opens_on, stage.closes_on) for stage in story.stages] == [
        (1, date(2026, 6, 1), date(2026, 6, 21)),
        (2, date(2026, 6, 22), date(2026, 7, 12)),
    ]
    habit.is_carryover = True
    assert build_habit_story(habit, [], [], context=context).stages == []


def test_tier_delta_compares_equal_windows_and_weeks_start_monday() -> None:
    """Recent and preceding windows keep tier changes independent from quiet days."""
    habit = _habit()
    rows = [
        _row(3, 2),
        GoalCompletion(goal_id=2, user_id=1, local_day=date(2026, 7, 4), completed_units=3),
    ]
    story = build_habit_story(habit, rows, [], context=HabitStoryContext(today=date(2026, 7, 20)))
    assert story.tiers.last_30_delta.model_dump() == {"low": 0, "clear": -1, "stretch": 1}
    assert all(week.week_start.weekday() == 0 for week in story.tiers.weekly)
    assert story.tiers.totals.quiet == len(story.days) - 2


def test_future_rows_and_events_are_outside_the_asof_calendar() -> None:
    """A stray future fact cannot change today's calendar, patterns, or log count."""
    log = GoalLogFact(
        id=1,
        timestamp=datetime(2026, 6, 3, tzinfo=UTC),
        local_day=date(2026, 6, 3),
        delta_units=100,
        via_timer=False,
        source="manual",
    )
    story = build_habit_story(
        _habit(), [_row(3, 100)], [log], context=HabitStoryContext(today=date(2026, 6, 2))
    )
    assert story.logged_days == story.log_count == 0
    assert story.patterns.weekday_units == [0] * 7
    assert story.patterns.unknown_time_units == 0
    assert story.continuity.days_with == 0


def test_future_start_and_no_goals_do_not_manufacture_history() -> None:
    """An unstarted habit and an empty goal ladder still produce valid responses."""
    habit = _habit(start=date(2026, 6, 3))
    habit.goals = []
    story = build_habit_story(habit, [], [], context=HabitStoryContext(today=date(2026, 6, 2)))
    assert story.days == []
    assert story.stages == []
    assert story.unit == ""
    assert story.rates.all_time.met == story.rates.all_time.scheduled == 0


def test_additive_runs_retain_the_canonical_recorded_day_rule() -> None:
    """A positive partial log extends canonical runs without inflating met-day rates."""
    story = build_habit_story(
        _habit(),
        [_row(1, 2), _row(2, 0.5), _row(4, 2)],
        [],
        context=HabitStoryContext(today=date(2026, 6, 5)),
    )
    assert story.continuity.current_run == 1
    assert story.continuity.longest_run == 2
    assert story.continuity.days_with == story.rates.all_time.met == 2


def test_subtractive_clock_override_preserves_existing_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Older callers use their timezone clock; pure callers can provide one shared as-of date."""
    monkeypatch.setattr(streaks, "today_in_tz", lambda _timezone: date(2026, 6, 3))
    context = SubtractiveContext(2, date(2026, 6, 1))
    assert streaks.subtractive_current_streak({}, "UTC", context) == 3
    assert streaks.subtractive_longest_streak({}, "UTC", context) == 3
    assert streaks.subtractive_current_streak({}, "UTC", context, today=date(2026, 6, 5)) == 5
    assert streaks.subtractive_longest_streak({}, "UTC", context, today=date(2026, 6, 5)) == 5


@pytest.mark.parametrize(
    ("frequency_unit", "frequency"), [("per_day", 3), ("per_session", 3), ("per_week", 1)]
)
def test_mixed_ladder_uses_each_tiers_own_target_rule(
    frequency_unit: str, frequency: float
) -> None:
    """Low keeps its own target rule even when Clear uses a different weekly frequency."""
    habit = _habit()
    habit.goals[0].frequency = frequency
    habit.goals[0].frequency_unit = frequency_unit
    habit.goals[1].frequency_unit = "per_week"
    habit.goals[1].frequency = 3
    story = build_habit_story(
        habit,
        [_row(1, 2)],
        [],
        context=HabitStoryContext(
            today=date(2026, 6, 7), cadence=PeriodCadence("per_week", 6, habit.start_date, False)
        ),
    )
    assert story.days[0].tier == "low"
    assert story.rates.all_time.met == 1
    assert story.rates.all_time.scheduled == 1


def test_actual_prestart_practice_can_establish_a_later_return() -> None:
    """A recorded older success remains the first use even when the schedule was reset."""
    habit = _habit(start=date(2026, 6, 3))
    story = build_habit_story(
        habit,
        [_row(1, 2), _row(4, 2)],
        [],
        context=HabitStoryContext(today=date(2026, 6, 4)),
    )
    assert story.continuity.returns == 1


def test_off_schedule_practice_can_establish_first_use_without_expanding_rate() -> None:
    """A real Tuesday fact precedes Wednesday's return after Monday was quiet."""
    habit = _habit()
    habit.notification_days = ["Mon", "Wed", "Fri"]
    story = build_habit_story(
        habit,
        [_row(2, 2), _row(3, 2)],
        [],
        context=HabitStoryContext(today=date(2026, 6, 3)),
    )
    assert story.continuity.returns == 1
    assert story.rates.all_time.met == 1
    assert story.rates.all_time.scheduled == 2
