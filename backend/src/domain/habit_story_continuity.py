"""Reuse the canonical streak owners; Story's new counts keep separate meanings."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date
from typing import TYPE_CHECKING

from domain.habit_story_rollups import cadence_unit, count_returns, lifetime_days_with
from domain.streaks import (
    current_consecutive_streak,
    longest_consecutive_streak,
    period_current_streak,
    period_longest_streak,
    subtractive_current_streak,
    subtractive_longest_streak,
)
from schemas.habit_story import HabitStoryContinuity

if TYPE_CHECKING:
    from domain.habit_story_types import HabitStoryContext
    from schemas.habit_story import HabitStoryDay


def _runs(totals: dict[date, float], context: HabitStoryContext) -> tuple[int, int]:
    """Preserve canonical cadence, polarity, recency grace, and recorded-day rules."""
    if context.cadence:
        return (
            period_current_streak(totals, context.today, context.cadence),
            period_longest_streak(totals, context.today, context.cadence),
        )
    if context.subtractive:
        return (
            subtractive_current_streak(
                totals, context.timezone, context.subtractive, today=context.today
            ),
            subtractive_longest_streak(
                totals, context.timezone, context.subtractive, today=context.today
            ),
        )
    recorded = sorted(day for day, amount in totals.items() if amount > 0)
    return current_consecutive_streak(recorded[::-1], context.today), longest_consecutive_streak(
        recorded
    )


def build_continuity(
    totals: dict[date, float], days: Sequence[HabitStoryDay], context: HabitStoryContext
) -> HabitStoryContinuity:
    """Runs match existing APIs; lifetime met units never become a rate numerator."""
    current, longest = _runs(totals, context)
    return HabitStoryContinuity(
        current_run=current,
        longest_run=longest,
        returns=count_returns(days, context),
        days_with=lifetime_days_with(days, context),
        unit=cadence_unit(context),
    )
