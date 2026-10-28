"""Templated observations and dated milestones for the Story payloads (#3525).

Every sentence is a fact about the person's own record, worded the way a wise
friend would say it: the figure, its denominator, and no comparison to anyone
else. The module follows the tone ``domain/contraction.py`` set: nothing here
counts anything as a loss, ranks a person, or flatters. Each function takes
value objects only -- no session, and no clock beyond the ``today`` it is
handed -- so the wording is tested without a database.

A sentence that has nothing true and useful to say returns ``None`` and is left
out; at most :data:`MAX_OBSERVATIONS` sentences go to one payload, in priority
order.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from itertools import accumulate
from typing import TYPE_CHECKING

from domain.dates import ensure_aware, to_user_date

if TYPE_CHECKING:
    from schemas.habit_story import HabitStoryDay, HabitStoryResponse, HabitStoryStage

MAX_OBSERVATIONS = 3

HABIT_DAY_MILESTONES = (7, 21, 100)
PRACTICE_MINUTE_MILESTONES = (60, 600, 3000)
PRACTICE_SESSION_MILESTONES = (10, 50, 100)

#: Below this many units with the habit, words stand in for the charts (D09).
EARLY_DAYS_MIN = 7
#: A rest at least this many scheduled days long makes the next met day a return.
RETURN_MIN_REST = 7
#: A stage counts as kept when at least two scheduled days in three were met.
STAGE_KEPT_NUMERATOR = 2
STAGE_KEPT_DENOMINATOR = 3
#: One weekday must exceed the mean by this factor to be named.
WEEKDAY_LEAN = 1.25
#: One time of day must hold this share of all sits to be named.
TIME_OF_DAY_SHARE = 0.4
#: The rhythm needs this many days before it has a shape to describe.
RHYTHM_MIN_DAYS = 28
#: Day-of-month cut points for "early", "mid" and "late" in a month.
EARLY_MONTH_LAST_DAY = 10
MID_MONTH_LAST_DAY = 20

MINUTES_PER_HOUR = 60
DEEPER_TIERS = frozenset({"clear", "stretch"})
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
NUMBER_WORDS = (
    "no",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
)
SINGULAR = {"days": "day", "weeks": "week", "months": "month"}
COMEBACK_WORDS = {1: "once", 2: "twice"}


@dataclass(frozen=True, slots=True)
class Milestone:
    """Something worth marking, dated the day it was reached."""

    kind: str
    reached_on: date
    value: int


@dataclass(frozen=True, slots=True)
class PracticeFacts:
    """The practice-story figures a sentence may draw on."""

    total_minutes: float
    total_sessions: int
    stage_ask_minutes: float | None
    stage_average_minutes: float | None
    time_of_day: dict[str, int]
    stage_name: str | None


@dataclass(frozen=True, slots=True)
class RhythmFacts:
    """The overview's rhythm facts and how many days the series spans."""

    fullest_fortnight_ending: date | None
    longest_rest: tuple[date, date] | None
    rising_since: date | None
    series_days: int


# --- wording helpers -----------------------------------------------------------


def _word(count: int) -> str:
    """Small counts read as words; larger ones keep their digits."""
    return NUMBER_WORDS[count] if 0 <= count < len(NUMBER_WORDS) else str(count)


def _plural(count: int, unit: str) -> str:
    """``unit`` is the plural; a count of one takes its singular."""
    return SINGULAR.get(unit, unit) if count == 1 else unit


def _count(count: int, noun: str) -> str:
    """A count with its noun, singular for one."""
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def _sits(count: int) -> str:
    """Count sits with the right noun."""
    return _count(count, "sit")


def _duration(minutes: float) -> str:
    """Whole minutes under an hour, otherwise hours and the minutes left over."""
    total = round(minutes)
    if total < MINUTES_PER_HOUR:
        return _count(total, "minute")
    hours, rest = divmod(total, MINUTES_PER_HOUR)
    if rest == 0:
        return _count(hours, "hour")
    return f"{_count(hours, 'hour')} {_count(rest, 'minute')}"


def _year_suffix(when: date, today: date) -> str:
    """Name the year only when it is not the current one."""
    return "" if when.year == today.year else f" {when.year}"


def _part_of_month(when: date, today: date) -> str:
    """Name the part of the month, as in late June or early November 2025."""
    if when.day <= EARLY_MONTH_LAST_DAY:
        part = "early"
    elif when.day <= MID_MONTH_LAST_DAY:
        part = "mid"
    else:
        part = "late"
    return f"{part} {when:%B}{_year_suffix(when, today)}"


def _day_month(when: date, today: date) -> str:
    """Name the day and month, as in 14 September, with the year when it is not this one."""
    return f"{when.day} {when:%B}{_year_suffix(when, today)}"


# --- habit -----------------------------------------------------------------------


def _deeper(day: HabitStoryDay) -> bool:
    """Whether the day reached Clear or Stretch."""
    return day.tier in DEEPER_TIERS


def _depth_clause(count: int, deeper: int) -> str:
    """How many early days reached Clear or beyond, if any did."""
    if deeper == 0:
        return ""
    if count == 1:
        return ", to Clear or beyond"
    return f", {_word(deeper)} of them to Clear or beyond"


def _early_days(story: HabitStoryResponse, name: str) -> str:
    """Words instead of charts while there is not yet a shape (D09)."""
    count, unit = story.continuity.days_with, story.continuity.unit
    tail = "The grid fills in as the days do."
    if count == 0:
        return f"No {unit} of {name} yet. {tail}"
    deeper = sum(1 for day in story.days if _deeper(day))
    opening = f"{_word(count).capitalize()} {_plural(count, unit)} of {name}"
    return f"{opening}{_depth_clause(count, deeper)}. {tail}"


def _kept_and_returns(story: HabitStoryResponse, name: str) -> str | None:
    """Days with the habit over scheduled days, and the times the person came back."""
    rate, returns = story.rates.all_time, story.continuity.returns
    if rate.scheduled == 0:
        return None
    kept = f"You have kept {name} on {rate.met} of {rate.scheduled} scheduled {story.rates.unit}"
    if returns == 0:
        return f"{kept}."
    return f"{kept}, and come back after a rest {COMEBACK_WORDS.get(returns, f'{returns} times')}."


def _deepening(story: HabitStoryResponse) -> str | None:
    """More Clear-or-beyond days than in the thirty before; silent otherwise."""
    delta = story.tiers.last_30_delta
    gain = delta.clear + delta.stretch
    if gain <= 0:
        return None
    return (
        f"In the last thirty days you reached Clear or beyond on {gain} more "
        f"{_plural(gain, 'days')} than in the thirty before."
    )


def _weekday(story: HabitStoryResponse) -> str | None:
    """The weekday that carries clearly more of the units than an even week would."""
    units = story.patterns.weekday_units
    mean = sum(units) / len(units) if units else 0
    if mean <= 0:
        return None
    top = max(range(len(units)), key=units.__getitem__)
    if units[top] < mean * WEEKDAY_LEAN:
        return None
    return f"You log most {story.unit} on {WEEKDAYS[top]}s."


def habit_observations(story: HabitStoryResponse, name: str) -> list[str]:
    """Up to three true sentences about one habit's record, most telling first."""
    if story.continuity.days_with < EARLY_DAYS_MIN:
        return [_early_days(story, name)]
    candidates = (_kept_and_returns(story, name), _deepening(story), _weekday(story))
    return [sentence for sentence in candidates if sentence][:MAX_OBSERVATIONS]


def _days_with_milestones(
    days: Sequence[HabitStoryDay], period_of: Callable[[date], date]
) -> Iterator[Milestone]:
    """Each threshold of kept native units, dated by the day it was crossed."""
    seen: set[date] = set()
    for day in days:
        period = period_of(day.date)
        if not day.met or period in seen:
            continue
        seen.add(period)
        if len(seen) in HABIT_DAY_MILESTONES:
            yield Milestone("days_with", day.date, len(seen))


def _first_stretch(days: Sequence[HabitStoryDay]) -> Iterator[Milestone]:
    """The first day that reached Stretch, once."""
    first = next((day for day in days if day.tier == "stretch"), None)
    if first is not None:
        yield Milestone("first_stretch", first.date, 1)


def _rests_before(days: Sequence[HabitStoryDay]) -> Iterator[tuple[HabitStoryDay, int]]:
    """Each met day with the scheduled, unmet days just before it (none before the first)."""
    began, rest = False, 0
    for day in days:
        if day.met:
            yield day, rest if began else 0
            began, rest = True, 0
        elif day.scheduled:
            rest += 1


def _returns(days: Sequence[HabitStoryDay]) -> Iterator[Milestone]:
    """A met day after a rest of at least a week of scheduled days."""
    return (
        Milestone("return", day.date, rest)
        for day, rest in _rests_before(days)
        if rest >= RETURN_MIN_REST
    )


def _stage_window(story: HabitStoryResponse, stage: HabitStoryStage) -> list[HabitStoryDay]:
    """The scheduled days a stage's calendar holds."""
    return [
        day for day in story.days if day.scheduled and stage.opens_on <= day.date <= stage.closes_on
    ]


def _stage_kept(story: HabitStoryResponse, stage: HabitStoryStage) -> bool:
    """Whether a closed stage met two of every three of its scheduled days."""
    window = _stage_window(story, stage) if stage.closes_on < story.today else []
    met = sum(1 for day in window if day.met)
    return bool(window) and met * STAGE_KEPT_DENOMINATOR >= STAGE_KEPT_NUMERATOR * len(window)


def _stages_kept(story: HabitStoryResponse) -> Iterator[Milestone]:
    """A closed stage in which two scheduled days in three were met."""
    return (
        Milestone("stage_complete", stage.closes_on, stage.stage_number)
        for stage in story.stages
        if _stage_kept(story, stage)
    )


def habit_milestones(
    story: HabitStoryResponse, *, period_of: Callable[[date], date]
) -> list[Milestone]:
    """Every habit milestone reached so far, in date order.

    ``period_of`` names the native period a day belongs to (the day itself for a
    daily habit), so a weekly habit counts each kept week once.
    """
    days = sorted(story.days, key=lambda day: day.date)
    found = [
        *_days_with_milestones(days, period_of),
        *_first_stretch(days),
        *_returns(days),
        *_stages_kept(story),
    ]
    return sorted(found, key=lambda milestone: milestone.reached_on)


# --- practice ----------------------------------------------------------------------


def _hours_and_sits(facts: PracticeFacts) -> str:
    """The lifetime time in practice and the sits it took."""
    return f"{_duration(facts.total_minutes)} of practice across {_sits(facts.total_sessions)}."


def _ask_and_average(facts: PracticeFacts) -> str | None:
    """The stage's ask beside this stage's own average, when both exist."""
    if not facts.stage_name or not facts.stage_ask_minutes or facts.stage_average_minutes is None:
        return None
    return (
        f"{facts.stage_name} asks for {round(facts.stage_ask_minutes)} minutes; "
        f"your sits this stage average {round(facts.stage_average_minutes)}."
    )


def _time_of_day(facts: PracticeFacts) -> str | None:
    """The time of day that holds at least two sits in five."""
    total = sum(facts.time_of_day.values())
    if total == 0:
        return None
    bucket, count = max(facts.time_of_day.items(), key=lambda item: item[1])
    if count < total * TIME_OF_DAY_SHARE:
        return None
    return f"{bucket.capitalize()} holds {count} of your {_sits(total)}."


def practice_observations(facts: PracticeFacts) -> list[str]:
    """Up to three true sentences about one practice's record."""
    if facts.total_sessions == 0:
        return ["No sits recorded yet. The record starts with the first one."]
    candidates = (_hours_and_sits(facts), _ask_and_average(facts), _time_of_day(facts))
    return [sentence for sentence in candidates if sentence][:MAX_OBSERVATIONS]


def _crossed(thresholds: tuple[int, ...], before: float, after: float) -> Iterator[int]:
    """Thresholds a running total passed on this step."""
    return (threshold for threshold in thresholds if before < threshold <= after)


def _sit_milestones(local: date, minutes: tuple[float, float], count: int) -> list[Milestone]:
    """What one sit crossed: running minutes before and after it, and its ordinal."""
    by_minutes = (
        Milestone("practice_minutes", local, threshold)
        for threshold in _crossed(PRACTICE_MINUTE_MILESTONES, *minutes)
    )
    by_count = (
        Milestone("practice_sessions", local, threshold)
        for threshold in _crossed(PRACTICE_SESSION_MILESTONES, count - 1, count)
    )
    return [*by_minutes, *by_count]


def practice_milestones(
    sits: Sequence[tuple[datetime, float]], *, tz: str | None
) -> list[Milestone]:
    """Minutes and sit-count thresholds, each dated by the local day of its sit."""
    ordered = sorted(sits, key=lambda sit: ensure_aware(sit[0]))
    totals = [0.0, *accumulate(minutes for _, minutes in ordered)]
    found: list[Milestone] = []
    for index, (timestamp, _minutes) in enumerate(ordered):
        local = to_user_date(tz, ensure_aware(timestamp))
        found.extend(_sit_milestones(local, (totals[index], totals[index + 1]), index + 1))
    return found


# --- rhythm ----------------------------------------------------------------------


def _fullest(facts: RhythmFacts, today: date) -> str | None:
    """The fortnight that held the most, by its part of the month."""
    when = facts.fullest_fortnight_ending
    return f"Your fullest fortnight was {_part_of_month(when, today)}." if when else None


def _rest(facts: RhythmFacts, today: date) -> str | None:
    """The longest quiet stretch, by its first and last day."""
    if facts.longest_rest is None:
        return None
    start, end = facts.longest_rest
    return f"You rested from {_day_month(start, today)} to {_day_month(end, today)}."


def _rising(facts: RhythmFacts, today: date) -> str | None:
    """Since when the wave has been climbing."""
    when = facts.rising_since
    return f"You have been rising since {_day_month(when, today)}." if when else None


def rhythm_observations(facts: RhythmFacts, *, today: date) -> list[str]:
    """One caption for the unnamed wave (D14): fullest fortnight, longest rest, rise."""
    candidates = (_fullest(facts, today), _rest(facts, today), _rising(facts, today))
    parts = [part for part in candidates if part]
    if parts:
        return [" ".join(parts)]
    if facts.series_days < RHYTHM_MIN_DAYS:
        return ["Your rhythm takes shape after four weeks of days."]
    return []
