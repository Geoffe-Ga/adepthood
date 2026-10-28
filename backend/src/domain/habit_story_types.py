"""Read-side values keep Habit Story independent of optional event registration."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime

from domain.streaks import PeriodCadence, SubtractiveContext


@dataclass(frozen=True, slots=True)
class GoalLogFact:
    """An actual recorded operation projected from an installed event table."""

    id: int
    timestamp: datetime
    local_day: date
    delta_units: float
    via_timer: bool
    source: str


@dataclass(frozen=True, slots=True)
class HabitStoryContext:
    """Clock, canonical scoring contexts, and known program anchor supplied by the caller."""

    today: date
    timezone: str = "UTC"
    subtractive: SubtractiveContext | None = None
    cadence: PeriodCadence | None = None
    program_started_on: date | None = None
