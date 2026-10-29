"""What the person had actually scheduled each day, and the rhythm that pools it.

The rhythm answers "of what I had scheduled lately, how much did I do?", so its
denominator holds only real asks:

* A habit joins on the day it entered the person's practice. A habit on the
  programme ladder joins when its stage opens -- or sooner, on the day the
  person unlocked it or first logged it -- and never before its start date. A
  carryover or off-ladder habit joins on its start date. A locked habit is never
  scheduled: unlocking is the person's choice to take it on.
* A daily cadence is scheduled on its notification days (every day when none are
  set) and met when the day reaches its lowest named tier.
* A weekly or monthly cadence asks for Low's ``frequency`` occasions per period
  (one when Low's own cadence differs from the habit's). An occasion is a day
  reaching Low's per-occasion target and counts on that day; any shortfall
  counts on the period's last day once that day is over -- so a twice-a-week
  habit is never scheduled seven days a week. A subtractive period habit is one
  ask, judged on the period's last day.
* With the practice ring on, each day asks for one counted sit.

The wave is the pooled share over the trailing seven days: kept asks over
scheduled asks, both carried in the payload so the client can show "23 of 37".
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import TYPE_CHECKING

from domain.dates import ensure_aware, to_user_date, to_user_date_bucket
from domain.practice_stats import MIN_COUNTED_DURATION_MINUTES
from domain.progress_inputs import (
    TIER_ORDER,
    OverviewHabitContext,
    OverviewInput,
    effective_goal_target,
    minimum_goal,
    stage_number,
    stage_opens_on,
)
from domain.streaks import PeriodUnit, is_scheduled_on, period_start
from schemas.progress import RestWindow, RhythmDay

if TYPE_CHECKING:
    from models.goal import Goal
    from models.habit import Habit

ROLLING_WINDOW_DAYS = 7
REST_RATE = 0.25
REST_START_DAYS = 28
RISING_MIN_DAYS = 7
RATE_EPSILON = 1e-9


@dataclass(frozen=True)
class DayCount:
    """Asks kept and asks scheduled on one local day."""

    met: int = 0
    scheduled: int = 0

    def __add__(self, other: DayCount) -> DayCount:
        """Pool two counts without turning them into a ratio."""
        return DayCount(self.met + other.met, self.scheduled + other.scheduled)


@dataclass(frozen=True)
class HabitTrack:
    """One joined habit's tiers, calendar and raw per-day units."""

    joined: date
    goals: Sequence[Goal]
    context: OverviewHabitContext
    notification_days: list[str] | None
    totals: dict[date, float]


@dataclass(frozen=True)
class Population:
    """Every scheduled ask behind one pass's rhythm and stage rates."""

    tracks: Sequence[HabitTrack]
    practice_days: set[date]
    enable_practices: bool
    today: date


def first_logs(data: OverviewInput) -> dict[int, date]:
    """The earliest positive log per habit: logging a habit is taking it on."""
    habit_by_goal = {goal.id: goal.habit_id for goal in data.goals}
    first: dict[int, date] = {}
    for row in data.completions:
        habit_id = habit_by_goal.get(row.goal_id)
        if habit_id is not None and row.completed_units > 0:
            first[habit_id] = min(first.get(habit_id, row.local_day), row.local_day)
    return first


def _ladder_stage(habit: Habit) -> int | None:
    """The programme stage a regular habit waits on; carryovers wait on none."""
    return None if habit.is_carryover else stage_number(habit.stage)


def _unlocked_on(habit: Habit, timezone: str) -> date | None:
    """The local day the person (or the programme) unlocked ``habit``, if stamped."""
    stamp = habit.auto_revealed_at
    return None if stamp is None else to_user_date(timezone, ensure_aware(stamp))


def joined_on(
    habit: Habit, *, first_log: date | None, pass_start: date, timezone: str
) -> date | None:
    """The day ``habit`` entered the person's practice in a pass, or None while locked."""
    if not habit.revealed:
        return None
    stage = _ladder_stage(habit)
    if stage is None:
        return habit.start_date
    earliest = [stage_opens_on(pass_start, stage), _unlocked_on(habit, timezone), first_log]
    return max(habit.start_date, min(day for day in earliest if day is not None))


def _totals(data: OverviewInput, goals: Sequence[Goal]) -> dict[date, float]:
    """Sum every tier's units per local day through today."""
    goal_ids = {goal.id for goal in goals}
    totals: dict[date, float] = defaultdict(float)
    for row in data.completions:
        if row.goal_id in goal_ids and row.local_day <= data.today:
            totals[row.local_day] += row.completed_units
    return dict(totals)


@dataclass(frozen=True)
class _PassFacts:
    """What every habit's track in one pass reads, gathered once."""

    pass_start: date
    goals: dict[int, list[Goal]]
    first_logs: dict[int, date]


def _track(data: OverviewInput, habit: Habit, facts: _PassFacts) -> HabitTrack | None:
    """A persisted, joined habit with at least one named tier, or None."""
    habit_id = habit.id or 0
    goals = facts.goals.get(habit_id, [])
    joined = joined_on(
        habit,
        first_log=facts.first_logs.get(habit_id),
        pass_start=facts.pass_start,
        timezone=data.timezone,
    )
    if joined is None or minimum_goal(goals) is None:
        return None
    return HabitTrack(
        joined=joined,
        goals=goals,
        context=data.habit_contexts.get(habit_id, OverviewHabitContext()),
        notification_days=habit.notification_days,
        totals=_totals(data, goals),
    )


def _goals_by_habit(data: OverviewInput) -> dict[int, list[Goal]]:
    """Group the bulk goal read once rather than per habit."""
    grouped: dict[int, list[Goal]] = defaultdict(list)
    for goal in data.goals:
        grouped[goal.habit_id].append(goal)
    return grouped


def _tracks(data: OverviewInput, pass_start: date) -> list[HabitTrack]:
    """Every joined habit's track; none when the habit ring is declined."""
    if not data.enable_habits:
        return []
    facts = _PassFacts(pass_start, _goals_by_habit(data), first_logs(data))
    return list(filter(None, (_track(data, habit, facts) for habit in data.habits)))


def _practice_days(data: OverviewInput) -> set[date]:
    """Count positive partials; a zero-duration abort never fills a day."""
    return {
        to_user_date_bucket(row.timestamp, data.timezone)
        for row in data.practice_sessions
        if row.duration_minutes > MIN_COUNTED_DURATION_MINUTES
    }


def build_population(data: OverviewInput, pass_start: date) -> Population:
    """Every joined habit's track for the pass anchored on ``pass_start``."""
    return Population(
        tracks=_tracks(data, pass_start),
        practice_days=_practice_days(data),
        enable_practices=data.enable_practices,
        today=data.today,
    )


def _reaches(goal: Goal, units: float, *, subtractive: bool) -> bool:
    """Effective targets need not remain ordered after public per-goal edits."""
    target = effective_goal_target(goal)
    return units <= target if subtractive else units >= target


def qualifies(goals: Sequence[Goal], units: float, *, subtractive: bool) -> bool:
    """Whether ``units`` reaches any named tier under the habit's polarity."""
    return any(
        _reaches(goal, units, subtractive=subtractive) for goal in goals if goal.tier in TIER_ORDER
    )


def _ends_period(day: date, unit: PeriodUnit) -> bool:
    """Whether ``day`` is the last day of its week or month."""
    return period_start(day + timedelta(days=1), unit) != period_start(day, unit)


def _kept_on(units: float, per_occasion: float) -> bool:
    """A day keeps one occasion when it reaches Low; any log does when Low asks nothing."""
    return units > 0 if per_occasion <= 0 else units + RATE_EPSILON >= per_occasion


def _period_days(track: HabitTrack, day: date, unit: PeriodUnit) -> list[date]:
    """The joined days of ``day``'s period before ``day``."""
    first = max(period_start(day, unit), track.joined)
    return [first + timedelta(days=n) for n in range((day - first).days)]


def _asked(low: Goal, unit: PeriodUnit) -> int:
    """Occasions per period: Low's own frequency when it shares the habit's cadence."""
    return max(1, math.ceil(low.frequency)) if low.frequency_unit == unit else 1


def _finished(day: date, today: date, unit: PeriodUnit) -> bool:
    """Whether ``day`` closes its period and that period is already over."""
    return _ends_period(day, unit) and day < today


def _occasion_count(track: HabitTrack, day: date, today: date, unit: PeriodUnit) -> DayCount:
    """Kept occasions on their day; the period's shortfall on its finished last day."""
    low = minimum_goal(track.goals)
    if low is None:
        return DayCount()
    asked = _asked(low, unit)
    earlier = sum(
        _kept_on(track.totals.get(past, 0), low.target) for past in _period_days(track, day, unit)
    )
    kept = min(int(_kept_on(track.totals.get(day, 0), low.target)), max(0, asked - earlier))
    shortfall = max(0, asked - earlier - kept) * _finished(day, today, unit)
    return DayCount(kept, kept + shortfall)


def _limit_count(track: HabitTrack, day: date, today: date, unit: PeriodUnit) -> DayCount:
    """A subtractive period is one ask, judged once its last day is over."""
    if not _finished(day, today, unit):
        return DayCount()
    total = sum(track.totals.get(past, 0) for past in [*_period_days(track, day, unit), day])
    return DayCount(int(qualifies(track.goals, total, subtractive=True)), 1)


def _daily_count(track: HabitTrack, day: date) -> DayCount:
    """A daily cadence asks on its notification days and is met at Low or above."""
    if not is_scheduled_on(track.notification_days, day.strftime("%a")):
        return DayCount()
    units = track.totals.get(day, 0)
    return DayCount(int(qualifies(track.goals, units, subtractive=track.context.subtractive)), 1)


def habit_count(track: HabitTrack, day: date, today: date) -> DayCount:
    """One habit's asks on one day, by its native cadence."""
    if day < track.joined:
        return DayCount()
    cadence = track.context.cadence
    if cadence is None:
        return _daily_count(track, day)
    if track.context.subtractive:
        return _limit_count(track, day, today, cadence.unit)
    return _occasion_count(track, day, today, cadence.unit)


def day_count(population: Population, day: date) -> DayCount:
    """Every habit's asks that day, plus one practice ask when the ring is on."""
    total = DayCount()
    for track in population.tracks:
        total += habit_count(track, day, population.today)
    if population.enable_practices:
        total += DayCount(int(day in population.practice_days), 1)
    return total


def calendar(start: date, end: date) -> list[date]:
    """Enumerate a half-open user-local calendar window."""
    return [start + timedelta(days=index) for index in range(max((end - start).days, 0))]


def rhythm_days(population: Population, start: date, end: date) -> list[RhythmDay]:
    """Pool the trailing seven days' asks for each day of ``[start, end)``."""
    counts = [(day, day_count(population, day)) for day in calendar(start, end)]
    result = []
    for index, (day, count) in enumerate(counts):
        window = [pair[1] for pair in counts[max(0, index - ROLLING_WINDOW_DAYS + 1) : index + 1]]
        pooled = sum(window, DayCount())
        result.append(
            RhythmDay(
                date=day,
                rate=pooled.met / pooled.scheduled if pooled.scheduled else 0,
                daily_met=count.met,
                daily_scheduled=count.scheduled,
                window_met=pooled.met,
                window_scheduled=pooled.scheduled,
                window_days=len(window),
            )
        )
    return result


def fullest_week(days: Sequence[RhythmDay]) -> date | None:
    """The earliest fullest complete week, never a partial opening window."""
    complete = [day for day in days if day.window_days == ROLLING_WINDOW_DAYS]
    return max(complete, key=lambda day: day.rate).date if complete else None


def longest_rest(days: Sequence[RhythmDay]) -> RestWindow | None:
    """The earliest longest below-threshold run after the opening four weeks."""
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


def rising_since(days: Sequence[RhythmDay]) -> date | None:
    """A current nondecreasing stretch needs seven days and one strict increase."""
    if len(days) < RISING_MIN_DAYS:
        return None
    start = _rise_start(days)
    rising = days[-1].rate > days[start].rate + RATE_EPSILON
    return days[start].date if rising and len(days) - start >= RISING_MIN_DAYS else None
