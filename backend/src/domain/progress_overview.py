"""Pure whole-person series over scoped values; no I/O or implicit provisioning.

The rhythm and the cycle comparison share one population of scheduled asks,
built in :mod:`domain.progress_rhythm`; this module adds the arc, its habit
births and the energy ledger. Canonical habit-level polarity/cadence are
supplied by the router, so legacy mixed ladders follow the same owners as
check-ins and Habit Story.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING, cast

from domain.constants import (
    DAYS_PER_WEEK,
    STAGE_DURATIONS_DAYS,
    TOTAL_PROGRAM_DAYS,
    TOTAL_PROGRAM_WEEKS,
)
from domain.dates import ensure_aware, to_user_date
from domain.observations import RhythmFacts, rhythm_observations
from domain.progress_inputs import (
    OverviewHabitContext,
    OverviewInput,
    effective_goal_target,
    live_anchor,
    minimum_goal,
    stage_number,
    start_day,
)
from domain.progress_rhythm import (
    DayCount,
    Population,
    build_population,
    calendar,
    day_count,
    first_logs,
    fullest_week,
    joined_on,
    longest_rest,
    rhythm_days,
    rising_since,
)
from domain.progress_units import habit_unit_histories
from schemas.progress import (
    ArcStage,
    CycleRate,
    EnergyWeek,
    HabitBirth,
    ProgressArc,
    ProgressEnergy,
    ProgressOverviewResponse,
    ProgressRhythm,
    StageCycleRates,
)

if TYPE_CHECKING:
    from models.goal_completion import GoalCompletion
    from models.habit import Habit

__all__ = [
    "OverviewHabitContext",
    "OverviewInput",
    "build_progress_overview",
    "effective_goal_target",
    "minimum_goal",
]

ENERGY_WEEKS = 12


def _birth_week(joined: date | None, start: date | None) -> int | None:
    """Place a join only within the known thirty-six-week ribbon."""
    if start is None or joined is None:
        return None
    represented_week = max(1, (joined - start).days // DAYS_PER_WEEK + 1)
    return represented_week if represented_week <= TOTAL_PROGRAM_WEEKS else None


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


def _stage_at_week(week: int) -> int:
    """The stage whose block holds ``week`` of the ribbon."""
    return next(
        index
        for index in range(1, len(STAGE_DURATIONS_DAYS) + 1)
        if sum(STAGE_DURATIONS_DAYS[:index]) >= week * DAYS_PER_WEEK
    )


def _birth(
    data: OverviewInput, habit: Habit, start: date | None, first_log: date | None
) -> HabitBirth:
    """A habit's join week in this pass; carryovers and locked habits have none."""
    joined = (
        None
        if start is None or habit.is_carryover
        else joined_on(habit, first_log=first_log, pass_start=start, timezone=data.timezone)
    )
    week = _birth_week(joined, start)
    recorded = stage_number(habit.stage)
    return HabitBirth(
        habit_id=cast("int", habit.id),
        name=habit.name,
        icon=habit.icon,
        week=week,
        stage_number=recorded if recorded is not None or week is None else _stage_at_week(week),
        is_carryover=habit.is_carryover,
        unit_histories=habit_unit_histories(
            habit.id, data.goals, data.completions, start=start, today=data.today
        ),
    )


def _births(data: OverviewInput, start: date | None) -> list[HabitBirth]:
    """Retained existing habits remain visible independently of reveal state."""
    if not data.enable_habits:
        return []
    logs = first_logs(data)
    return [
        _birth(data, habit, start, logs.get(habit.id))
        for habit in data.habits
        if habit.id is not None and habit.start_date <= data.today
    ]


def _arc(data: OverviewInput) -> ProgressArc:
    """Return placement without deriving a missing anchor from unrelated rows."""
    start = start_day(data)
    return ProgressArc(
        program_started_at=live_anchor(data),
        cycle_number=data.progress.cycle_number if data.progress else 1,
        current_stage=data.progress.current_stage if data.progress else 1,
        current_week=_current_week(data, start),
        stages=_arc_stages(data, start),
        habit_births=_births(data, start),
    )


def _rhythm(data: OverviewInput) -> ProgressRhythm:
    """The live pass's pooled wave and the three facts read from it."""
    start = start_day(data)
    days = (
        []
        if start is None
        else rhythm_days(
            build_population(data, start),
            start,
            min(data.today + timedelta(days=1), start + timedelta(days=TOTAL_PROGRAM_DAYS)),
        )
    )
    return ProgressRhythm(
        days=days,
        fullest_week_ending=fullest_week(days),
        longest_rest=longest_rest(days),
        rising_since=rising_since(days),
    )


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
        return live_anchor(data)
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


def _cycle_rate(population: Population, cycle: int, start: date, end: date) -> CycleRate:
    """Pool every ask within one stage window and disclose both counts."""
    pooled = sum((day_count(population, day) for day in calendar(start, end)), DayCount())
    return CycleRate(
        cycle=cycle,
        rate=pooled.met / pooled.scheduled if pooled.scheduled else 0,
        met_days=pooled.met,
        scheduled_days=pooled.scheduled,
    )


def _append_cycle(data: OverviewInput, cycle: int, stages: list[StageCycleRates]) -> None:
    """Append one known pass in fixed stage order without extending its calendar."""
    bounds = _cycle_bounds(data, cycle)
    if bounds is None:
        return
    start, end = bounds
    population = build_population(data, start)
    for stage, duration in zip(stages, STAGE_DURATIONS_DAYS, strict=True):
        stage.rates.append(
            _cycle_rate(population, cycle, start, min(start + timedelta(days=duration), end))
        )
        start += timedelta(days=duration)


def _cycles(data: OverviewInput) -> list[StageCycleRates]:
    """All ten fixed stage identities, with only retained known cycle windows."""
    if data.progress is None or data.progress.cycle_number == 1:
        return []
    stages = [
        StageCycleRates(stage_number=index, rates=[])
        for index in range(1, len(STAGE_DURATIONS_DAYS) + 1)
    ]
    for cycle in range(1, data.progress.cycle_number + 1):
        _append_cycle(data, cycle, stages)
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
    rhythm = _rhythm(data)
    return ProgressOverviewResponse(
        arc=_arc(data),
        rhythm=rhythm,
        cycles=_cycles(data),
        energy=_energy(data),
        observations=rhythm_observations(_rhythm_facts(rhythm), today=data.today),
    )


def _rhythm_facts(rhythm: ProgressRhythm) -> RhythmFacts:
    """The wave's facts in the shape the observation templates read.

    A wave that never rose above zero has no week worth calling fullest.
    """
    rest = rhythm.longest_rest
    rose = any(day.rate > 0 for day in rhythm.days)
    return RhythmFacts(
        fullest_week_ending=rhythm.fullest_week_ending if rose else None,
        longest_rest=None if rest is None else (rest.start, rest.end),
        rising_since=rhythm.rising_since,
        series_days=len(rhythm.days),
    )
