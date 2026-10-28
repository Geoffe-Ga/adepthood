"""Pure whole-person series over scoped values; no I/O or implicit provisioning.

Cycle rates use the same habit-day plus enabled-practice opportunities as the
rhythm. Its rolling rate is the mean of daily fractions, never a pooled ratio.
Canonical habit-level polarity/cadence are supplied by the router, so legacy
mixed ladders follow the same owners as check-ins and Habit Story.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING

from domain.constants import (
    DAYS_PER_WEEK,
    STAGE_DURATIONS_DAYS,
    TOTAL_PROGRAM_DAYS,
    TOTAL_PROGRAM_WEEKS,
)
from domain.dates import ensure_aware, to_user_date, to_user_date_bucket
from domain.frequencies import FREQUENCY_COLORS
from domain.observations import RhythmFacts, rhythm_observations
from domain.practice_stats import MIN_COUNTED_DURATION_MINUTES
from domain.progress_units import habit_unit_histories
from domain.streaks import PERIOD_UNITS, PeriodCadence, is_scheduled_on, period_start
from schemas.progress import (
    ArcStage,
    CycleRate,
    EnergyWeek,
    HabitBirth,
    ProgressArc,
    ProgressEnergy,
    ProgressOverviewResponse,
    ProgressRhythm,
    RestWindow,
    RhythmDay,
    StageCycleRates,
)

if TYPE_CHECKING:
    from models.goal import Goal
    from models.goal_completion import GoalCompletion
    from models.habit import Habit
    from models.practice_session import PracticeSession
    from models.stage_progress import StageProgress

REST_RATE = 0.25
RISING_MIN_DAYS = 7
ROLLING_WINDOW_DAYS = 14
ENERGY_WEEKS = 12
REST_START_DAYS = 28
RATE_EPSILON = 1e-12
_TIER_ORDER = ("low", "clear", "stretch")
_STAGE_BY_COLOR = {
    color.casefold(): index for index, color in enumerate(FREQUENCY_COLORS.values(), 1)
}


@dataclass(frozen=True)
class OverviewHabitContext:
    """Canonical habit-wide polarity and native calendar used to bucket engagement.

    The cadence's run target is not an engagement threshold: each named tier
    keeps its own effective target, including after single-goal edits.
    """

    cadence: PeriodCadence | None = None
    subtractive: bool = False


@dataclass(frozen=True)
class OverviewInput:
    """Already-authorized rows and explicit calendar, rings and catalog labels."""

    today: date
    timezone: str
    progress: StageProgress | None = None
    habits: Sequence[Habit] = ()
    goals: Sequence[Goal] = ()
    completions: Sequence[GoalCompletion] = ()
    practice_sessions: Sequence[PracticeSession] = ()
    aspects: dict[int, str] = field(default_factory=dict)
    practice_asks: dict[int, float] = field(default_factory=dict)
    habit_contexts: dict[int, OverviewHabitContext] = field(default_factory=dict)
    enable_habits: bool = True
    enable_practices: bool = True


def minimum_goal(goals: Sequence[Goal]) -> Goal | None:
    """Choose the lowest existing named tier, independent of database row order."""
    return next((goal for tier in _TIER_ORDER for goal in goals if goal.tier == tier), None)


def effective_goal_target(goal: Goal) -> float:
    """Keep each tier's own effective target, independent of its siblings."""
    return goal.target * goal.frequency if goal.frequency_unit in PERIOD_UNITS else goal.target


def _anchor(data: OverviewInput) -> datetime | None:
    """Only a persisted live programme anchor can establish calendar provenance."""
    return (
        ensure_aware(data.progress.program_started_at)
        if data.progress and data.progress.program_started_at is not None
        else None
    )


def _start_day(data: OverviewInput) -> date | None:
    """Resolve the known anchor in the user's current calendar."""
    anchor = _anchor(data)
    return to_user_date(data.timezone, anchor) if anchor is not None else None


def _stage_number(stage: str) -> int | None:
    """Colour identities are canonical; retain recognized numeric legacy stages."""
    if stage.isdigit():
        value = int(stage)
        return value if 1 <= value <= len(STAGE_DURATIONS_DAYS) else None
    return _STAGE_BY_COLOR.get(" ".join(stage.split()).casefold())


def _birth_week(habit: Habit, start: date | None, *, carryover: bool) -> int | None:
    """Place a recorded birth only within the known thirty-six-week ribbon."""
    if start is None or carryover:
        return None
    represented_week = max(1, (habit.start_date - start).days // DAYS_PER_WEEK + 1)
    return represented_week if represented_week <= TOTAL_PROGRAM_WEEKS else None


def _birth(habit: Habit, start: date | None) -> HabitBirth:
    """Project current-cycle provenance without changing pre-program storage."""
    carryover = habit.is_carryover
    return HabitBirth(
        habit_id=habit.id,
        name=habit.name,
        icon=habit.icon,
        week=_birth_week(habit, start, carryover=carryover),
        stage_number=_stage_number(habit.stage),
        is_carryover=carryover,
    )


def _arc_stages(data: OverviewInput, start: date | None) -> list[ArcStage]:
    """The canonical ten blocks retain their native durations even without dates."""
    stages = []
    offset = 0
    for stage, duration in enumerate(STAGE_DURATIONS_DAYS, 1):
        stages.append(
            ArcStage(
                stage_number=stage,
                aspect=data.aspects.get(stage, ""),
                weeks=duration // DAYS_PER_WEEK,
                opens_on=start + timedelta(days=offset) if start is not None else None,
                practice_ask_minutes=data.practice_asks.get(stage),
            )
        )
        offset += duration
    return stages


def _current_week(data: OverviewInput, start: date | None) -> int | None:
    """The current rule stays inside the programme's thirty-six-week extent."""
    return (
        min(max((data.today - start).days // DAYS_PER_WEEK + 1, 1), TOTAL_PROGRAM_WEEKS)
        if start is not None
        else None
    )


def _overview_birth(data: OverviewInput, habit: Habit, start: date | None) -> HabitBirth:
    """Adoption colour follows its calendar position, including zero-offset Beige."""
    birth = _birth(habit, start)
    if birth.week is not None:
        birth.stage_number = next(
            stage.stage_number
            for stage in _arc_stages(data, start)
            if sum(STAGE_DURATIONS_DAYS[: stage.stage_number]) >= birth.week * DAYS_PER_WEEK
        )
    birth.unit_histories = habit_unit_histories(
        habit.id, data.goals, data.completions, start=start, today=data.today
    )
    return birth


def _births(data: OverviewInput, start: date | None) -> list[HabitBirth]:
    """Retained existing habits remain visible independently of reveal state."""
    if not data.enable_habits:
        return []
    return [
        _overview_birth(data, habit, start)
        for habit in data.habits
        if habit.id is not None and habit.start_date <= data.today
    ]


def _arc(data: OverviewInput) -> ProgressArc:
    """Return placement without deriving a missing anchor from unrelated rows."""
    start = _start_day(data)
    return ProgressArc(
        program_started_at=_anchor(data),
        cycle_number=data.progress.cycle_number if data.progress else 1,
        current_stage=data.progress.current_stage if data.progress else 1,
        current_week=_current_week(data, start),
        stages=_arc_stages(data, start),
        habit_births=_births(data, start),
    )


@dataclass(frozen=True)
class _HabitSeries:
    """One habit's named tiers and summed native-calendar outcomes."""

    habit: Habit
    goals: Sequence[Goal]
    context: OverviewHabitContext
    totals: dict[date, float]


def _history_row(row: GoalCompletion, today: date, goal_ids: set[int | None]) -> bool:
    """Retain actual recorded units through today, independently of birth edits."""
    return row.goal_id in goal_ids and row.local_day <= today


def _habit_totals(
    data: OverviewInput, goals: Sequence[Goal], context: OverviewHabitContext
) -> dict[date, float]:
    """Collapse every tier's units into their native calendar buckets."""
    goal_ids = {goal.id for goal in goals}
    totals: dict[date, float] = defaultdict(float)
    for completion in data.completions:
        if _history_row(completion, data.today, goal_ids):
            day = (
                period_start(completion.local_day, context.cadence.unit)
                if context.cadence
                else completion.local_day
            )
            totals[day] += completion.completed_units
    return dict(totals)


def _habit_series(data: OverviewInput, habit: Habit) -> _HabitSeries | None:
    """A weekly/monthly outcome belongs to the whole containing native period."""
    if habit.id is None:
        return None
    goals = [goal for goal in data.goals if goal.habit_id == habit.id]
    if minimum_goal(goals) is None:
        return None
    context = data.habit_contexts.get(habit.id, OverviewHabitContext())
    return _HabitSeries(habit, goals, context, _habit_totals(data, goals, context))


def _qualifies_named_tier(goal: Goal, units: float, *, subtractive: bool) -> bool:
    """Effective targets need not remain ordered after public per-goal edits."""
    if goal.tier not in _TIER_ORDER:
        return False
    target = effective_goal_target(goal)
    return units <= target if subtractive else units >= target


def _habit_met(series: _HabitSeries, day: date) -> bool:
    """Count Low or any higher named qualifying tier once for this habit."""
    cadence = series.context.cadence
    bucket = period_start(day, cadence.unit) if cadence else day
    units = series.totals.get(bucket, 0)
    return any(
        _qualifies_named_tier(goal, units, subtractive=series.context.subtractive)
        for goal in series.goals
    )


@dataclass(frozen=True)
class _Population:
    """The shared raw opportunity population behind rhythm and cycle rates."""

    habits: Sequence[_HabitSeries]
    practice_days: set[date]
    enable_practices: bool


def _habit_population(data: OverviewInput) -> list[_HabitSeries]:
    """A declined habit ring has no scheduled or met opportunities."""
    if not data.enable_habits:
        return []
    habits = [_habit_series(data, habit) for habit in data.habits]
    return [habit for habit in habits if habit is not None]


def _practice_days(data: OverviewInput) -> set[date]:
    """Count positive partials; a zero-duration abort never fills a day."""
    return {
        to_user_date_bucket(row.timestamp, data.timezone)
        for row in data.practice_sessions
        if row.duration_minutes > MIN_COUNTED_DURATION_MINUTES
    }


def _population(data: OverviewInput) -> _Population:
    """Build value-only series once, before walking any calendar window."""
    return _Population(_habit_population(data), _practice_days(data), data.enable_practices)


def _scheduled(series: _HabitSeries, day: date) -> bool:
    """A habit exists from its birth and follows its notification-day schedule."""
    return day >= series.habit.start_date and is_scheduled_on(
        series.habit.notification_days, day.strftime("%a")
    )


def _daily_pair(population: _Population, day: date) -> tuple[int, int]:
    """At most one met outcome per scheduled habit, and one practice day."""
    scheduled = [series for series in population.habits if _scheduled(series, day)]
    met = sum(_habit_met(series, day) for series in scheduled)
    practice = int(population.enable_practices)
    return met + int(population.enable_practices and day in population.practice_days), len(
        scheduled
    ) + practice


def _days(start: date, end: date) -> list[date]:
    """Enumerate a half-open user-local calendar window."""
    return [start + timedelta(days=index) for index in range(max((end - start).days, 0))]


def _rhythm_days(data: OverviewInput, population: _Population) -> list[RhythmDay]:
    """Mean the most recent fourteen daily fractions, preserving their raw pairs."""
    start = _start_day(data)
    if start is None:
        return []
    end = min(data.today + timedelta(days=1), start + timedelta(days=TOTAL_PROGRAM_DAYS))
    fractions: list[float] = []
    result = []
    for day in _days(start, end):
        met, scheduled = _daily_pair(population, day)
        fractions.append(met / scheduled if scheduled else 0)
        window = fractions[-ROLLING_WINDOW_DAYS:]
        result.append(
            RhythmDay(
                date=day,
                rate=sum(window) / len(window),
                daily_met=met,
                daily_scheduled=scheduled,
                window_days=len(window),
            )
        )
    return result


def _fullest(days: Sequence[RhythmDay]) -> date | None:
    """Choose the earliest fullest complete fortnight, never a partial opening."""
    complete = [day for day in days if day.window_days == ROLLING_WINDOW_DAYS]
    return max(complete, key=lambda day: day.rate).date if complete else None


def _rest(days: Sequence[RhythmDay]) -> RestWindow | None:
    """Find the earliest longest below-threshold run after the opening four weeks."""
    longest: list[RhythmDay] = []
    current: list[RhythmDay] = []
    for day in days[REST_START_DAYS:]:
        current = [*current, day] if day.rate < REST_RATE else []
        if len(current) > len(longest):
            longest = current
    return RestWindow(start=longest[0].date, end=longest[-1].date) if longest else None


def _rise_start(days: Sequence[RhythmDay]) -> int:
    """Locate the start of the final nondecreasing stretch."""
    start = len(days) - 1
    while start > 0 and days[start].rate + RATE_EPSILON >= days[start - 1].rate:
        start -= 1
    return start


def _rising(days: Sequence[RhythmDay]) -> date | None:
    """A current nondecreasing stretch needs seven days and one strict increase."""
    if len(days) < RISING_MIN_DAYS:
        return None
    start = _rise_start(days)
    rising = days[-1].rate > days[start].rate + RATE_EPSILON
    return days[start].date if rising and len(days) - start >= RISING_MIN_DAYS else None


def _parsed_anchor(raw: str | None) -> datetime | None:
    """A damaged stored anchor is unknown, not a reason to invent a calendar."""
    try:
        return ensure_aware(datetime.fromisoformat(raw)) if raw else None
    except ValueError:
        return None


def _retained_anchor(data: OverviewInput, cycle: int) -> datetime | None:
    """Unknown or damaged retained anchors remain unknown, with no fallback."""
    if data.progress is None:
        return None
    if cycle == data.progress.cycle_number:
        return _anchor(data)
    anchors = data.progress.past_cycle_anchors or []
    raw = anchors[cycle - 1] if cycle <= len(anchors) else None
    return _parsed_anchor(raw)


def _cycle_bounds(data: OverviewInput, cycle: int) -> tuple[date, date] | None:
    """A past cycle requires both anchors; its successor owns the loop's local day."""
    anchor = _retained_anchor(data, cycle)
    if anchor is None or data.progress is None:
        return None
    start = to_user_date(data.timezone, anchor)
    end = min(start + timedelta(days=TOTAL_PROGRAM_DAYS), data.today + timedelta(days=1))
    if cycle < data.progress.cycle_number:
        successor = _retained_anchor(data, cycle + 1)
        if successor is None:
            return None
        end = min(end, to_user_date(data.timezone, successor))
    return start, end


def _cycle_rate(population: _Population, cycle: int, start: date, end: date) -> CycleRate:
    """Pool raw opportunities within one stage window and disclose both counts."""
    pairs = [_daily_pair(population, day) for day in _days(start, end)]
    met, scheduled = sum(pair[0] for pair in pairs), sum(pair[1] for pair in pairs)
    return CycleRate(
        cycle=cycle,
        rate=met / scheduled if scheduled else 0,
        met_days=met,
        scheduled_days=scheduled,
    )


def _append_cycle(
    data: OverviewInput, population: _Population, cycle: int, stages: list[StageCycleRates]
) -> None:
    """Append one known pass in fixed stage order without extending its calendar."""
    bounds = _cycle_bounds(data, cycle)
    if bounds is None:
        return
    start, end = bounds
    for stage, duration in zip(stages, STAGE_DURATIONS_DAYS, strict=True):
        stage.rates.append(
            _cycle_rate(population, cycle, start, min(start + timedelta(days=duration), end))
        )
        start += timedelta(days=duration)


def _cycles(data: OverviewInput, population: _Population) -> list[StageCycleRates]:
    """All ten fixed stage identities, with only retained known cycle windows."""
    if data.progress is None or data.progress.cycle_number == 1:
        return []
    stages = [
        StageCycleRates(stage_number=index, rates=[])
        for index in range(1, len(STAGE_DURATIONS_DAYS) + 1)
    ]
    for cycle in range(1, data.progress.cycle_number + 1):
        _append_cycle(data, population, cycle, stages)
    return stages


def _energy_habits_by_goal(data: OverviewInput) -> dict[int | None, Habit]:
    """Map retained goals to their habits only when that ring is enabled."""
    if not data.enable_habits:
        return {}
    by_habit = {habit.id: habit for habit in data.habits}
    return {goal.id: by_habit[goal.habit_id] for goal in data.goals if goal.habit_id in by_habit}


def _energy_row(
    row: GoalCompletion, first: date, today: date, by_goal: dict[int | None, Habit]
) -> bool:
    """Only positive completions in the visible local window create energy."""
    return row.completed_units > 0 and first <= row.local_day <= today and row.goal_id in by_goal


def _energy_totals(data: OverviewInput, first: date) -> dict[date, int]:
    """Sum the persisted ledger facts; never reinterpret the UTC audit clock."""
    by_goal = _energy_habits_by_goal(data)
    totals: dict[date, int] = defaultdict(int)
    for row in data.completions:
        if _energy_row(row, first, data.today, by_goal):
            habit = by_goal[row.goal_id]
            totals[row.local_day - timedelta(days=row.local_day.weekday())] += (
                habit.energy_return - habit.energy_cost
            )
    return totals


def _energy(data: OverviewInput) -> ProgressEnergy:
    """Twelve Monday-start ledger buckets over actual positive completion rows."""
    monday = data.today - timedelta(days=data.today.weekday())
    first = monday - timedelta(weeks=ENERGY_WEEKS - 1)
    totals = _energy_totals(data, first)
    return ProgressEnergy(
        weeks=[
            EnergyWeek(
                week_start=first + timedelta(weeks=index),
                net=totals[first + timedelta(weeks=index)],
            )
            for index in range(ENERGY_WEEKS)
        ]
    )


def build_progress_overview(data: OverviewInput) -> ProgressOverviewResponse:
    """Compose the four series solely from explicit scoped values and calendar."""
    population = _population(data)
    days = _rhythm_days(data, population)
    rhythm = ProgressRhythm(
        days=days,
        fullest_fortnight_ending=_fullest(days),
        longest_rest=_rest(days),
        rising_since=_rising(days),
    )
    return ProgressOverviewResponse(
        arc=_arc(data),
        rhythm=rhythm,
        cycles=_cycles(data, population),
        energy=_energy(data),
        observations=rhythm_observations(_rhythm_facts(rhythm), today=data.today),
    )


def _rhythm_facts(rhythm: ProgressRhythm) -> RhythmFacts:
    """The wave's facts in the shape the observation templates read.

    A wave that never rose above zero has no fortnight worth calling fullest.
    """
    rest = rhythm.longest_rest
    rose = any(day.rate > 0 for day in rhythm.days)
    return RhythmFacts(
        fullest_fortnight_ending=rhythm.fullest_fortnight_ending if rose else None,
        longest_rest=None if rest is None else (rest.start, rest.end),
        rising_since=rhythm.rising_since,
        series_days=len(rhythm.days),
    )
