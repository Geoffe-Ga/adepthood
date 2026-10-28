"""Scheduled denominators and daily tier stacks over already-scored day cells."""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Sequence
from datetime import date, timedelta
from itertools import pairwise
from typing import TYPE_CHECKING

from domain.habit_story_calendar import native_day
from schemas.habit_story import (
    HabitStoryDay,
    HabitStoryRate,
    HabitStoryRates,
    HabitStoryTierCounts,
    HabitStoryTierDelta,
    HabitStoryTiers,
    HabitStoryWeek,
    StoryUnit,
)

if TYPE_CHECKING:
    from domain.habit_story_types import HabitStoryContext

_WINDOW_DAYS = 30


def cadence_unit(context: HabitStoryContext) -> StoryUnit:
    """Label native counts so a weekly count cannot imply a daily denominator."""
    if context.cadence is None:
        return "days"
    return "weeks" if context.cadence.unit == "per_week" else "months"


def scheduled_outcomes(
    days: Sequence[HabitStoryDay], context: HabitStoryContext
) -> dict[date, bool]:
    """Deduplicate native periods containing at least one scheduled alive day."""
    return {native_day(day.date, context): day.met for day in days if day.scheduled}


def lifetime_days_with(days: Sequence[HabitStoryDay], context: HabitStoryContext) -> int:
    """Keep real pre-start met records, never invented pre-start abstention."""
    return len({native_day(day.date, context) for day in days if day.met})


def count_returns(days: Sequence[HabitStoryDay], context: HabitStoryContext) -> int:
    """Count met native units following an unmet scheduled unit, excluding first use."""
    outcomes = list(scheduled_outcomes(days, context).items())
    first_met = next((native_day(day.date, context) for day in days if day.met), None)
    return sum(
        _returned_after_first_met(current, first_met, previous_met=previous[1])
        for previous, current in pairwise(outcomes)
    )


def _returned_after_first_met(
    current: tuple[date, bool], first_met: date | None, *, previous_met: bool
) -> bool:
    """Real pre-start or off-schedule practice can establish that adoption already happened."""
    if first_met is None:
        return False
    day, met = current
    return met and not previous_met and day > first_met


def _rate(days: Sequence[HabitStoryDay], context: HabitStoryContext) -> HabitStoryRate:
    """Use met scheduled periods as numerator, never the lifetime Days with figure."""
    outcomes = scheduled_outcomes(days, context)
    return HabitStoryRate(met=sum(outcomes.values()), scheduled=len(outcomes))


def _window_rate(
    days: Sequence[HabitStoryDay], context: HabitStoryContext, window: int
) -> HabitStoryRate:
    """A calendar-day window counts the scheduled native periods it intersects."""
    first = context.today - timedelta(days=window - 1)
    return _rate([day for day in days if day.date >= first], context)


def build_rates(days: Sequence[HabitStoryDay], context: HabitStoryContext) -> HabitStoryRates:
    """Keep rolling calendar windows and native cadence explicit on the wire."""
    return HabitStoryRates(
        last_7=_window_rate(days, context, 7),
        last_21=_window_rate(days, context, 21),
        last_30=_window_rate(days, context, _WINDOW_DAYS),
        all_time=_rate(days, context),
        unit=cadence_unit(context),
    )


def _category(day: HabitStoryDay) -> str | None:
    """A quiet period-day stays quiet in the stack, even when its period is met."""
    if day.logged:
        return day.tier or "under"
    return "quiet" if day.scheduled else None


def _tier_counts(days: Sequence[HabitStoryDay]) -> HabitStoryTierCounts:
    """Preserve under and quiet independently from a met tier."""
    counts = Counter(_category(day) for day in days)
    return HabitStoryTierCounts(
        low=counts["low"],
        clear=counts["clear"],
        stretch=counts["stretch"],
        under=counts["under"],
        quiet=counts["quiet"],
    )


def _weekly(days: Sequence[HabitStoryDay]) -> list[HabitStoryWeek]:
    """Keep Monday-start weeks across the displayed series, including quiet weeks."""
    grouped: defaultdict[date, list[HabitStoryDay]] = defaultdict(list)
    for day in days:
        grouped[day.date - timedelta(days=day.date.weekday())].append(day)
    weeks = []
    for start, cells in grouped.items():
        counts = _tier_counts(cells)
        weeks.append(
            HabitStoryWeek(
                week_start=start,
                low=counts.low,
                clear=counts.clear,
                stretch=counts.stretch,
                under=counts.under,
                quiet=counts.quiet,
            )
        )
    return weeks


def _delta(days: Sequence[HabitStoryDay], context: HabitStoryContext) -> HabitStoryTierDelta:
    """Compare equal thirty-calendar-day windows of logged tier facts."""
    recent_start = context.today - timedelta(days=_WINDOW_DAYS - 1)
    previous_start = recent_start - timedelta(days=_WINDOW_DAYS)
    recent = _tier_counts([day for day in days if day.date >= recent_start])
    previous = _tier_counts([day for day in days if previous_start <= day.date < recent_start])
    return HabitStoryTierDelta(
        low=recent.low - previous.low,
        clear=recent.clear - previous.clear,
        stretch=recent.stretch - previous.stretch,
    )


def build_tiers(days: Sequence[HabitStoryDay], context: HabitStoryContext) -> HabitStoryTiers:
    """Return the daily mix without conflating a quiet cell and its period outcome."""
    return HabitStoryTiers(
        totals=_tier_counts(days), weekly=_weekly(days), last_30_delta=_delta(days, context)
    )
