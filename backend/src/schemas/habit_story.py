"""Habit Story facts with explicit calendars, denominators, and timing coverage."""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel

StoryTier = Literal["low", "clear", "stretch"]
StoryUnit = Literal["days", "weeks", "months"]


class HabitStoryDay(BaseModel):
    """One real calendar day; period outcomes do not alter its raw daily units."""

    date: date
    units: float
    unknown_time_units: float
    tier: StoryTier | None
    logged: bool
    scheduled: bool
    met: bool


class HabitStoryStage(BaseModel):
    """Inclusive stage boundaries intersecting the displayed history."""

    stage_number: int
    opens_on: date
    closes_on: date


class HabitStoryContinuity(BaseModel):
    """Canonical runs and lifetime met units, separate from scheduled rates."""

    current_run: int
    longest_run: int
    returns: int
    days_with: int
    unit: StoryUnit


class HabitStoryRate(BaseModel):
    """A scheduled native-cadence numerator and denominator."""

    met: int
    scheduled: int


class HabitStoryRates(BaseModel):
    """Calendar-window rates expressed in scheduled days, weeks, or months."""

    last_7: HabitStoryRate
    last_21: HabitStoryRate
    last_30: HabitStoryRate
    all_time: HabitStoryRate
    unit: StoryUnit


class HabitStoryTierCounts(BaseModel):
    """Daily tier mix, keeping logged-under and unlogged-quiet distinct."""

    low: int = 0
    clear: int = 0
    stretch: int = 0
    under: int = 0
    quiet: int = 0


class HabitStoryWeek(HabitStoryTierCounts):
    """A Monday-start daily tier stack."""

    week_start: date


class HabitStoryTierDelta(BaseModel):
    """Tier counts in the last thirty days minus the preceding thirty."""

    low: int
    clear: int
    stretch: int


class HabitStoryTiers(BaseModel):
    """Lifetime and weekly daily tier distributions."""

    totals: HabitStoryTierCounts
    weekly: list[HabitStoryWeek]
    last_30_delta: HabitStoryTierDelta


class HabitStoryPatterns(BaseModel):
    """Signed timing totals; legacy residuals never borrow aggregate timestamps."""

    weekday_units: list[float]
    weekday_by_time_of_day: list[list[float]]
    unknown_time_units: float
    time_of_day_available_since: date | None


class HabitStoryLog(BaseModel):
    """A recorded operation; local_day is represented day, timestamp is recording time."""

    timestamp: datetime
    local_day: date
    delta_units: float
    via_timer: bool
    source: str


class HabitStoryMilestone(BaseModel):
    """A future observation-engine milestone, empty in the foundation response."""

    kind: str
    reached_on: date
    value: int


class HabitStoryResponse(BaseModel):
    """Everything Story and Ledger draw, scored by the server at native cadence."""

    polarity: Literal["additive", "subtractive"]
    cadence: Literal["day", "week", "month"]
    unit: str
    start_date: date
    today: date
    logged_days: int
    log_count: int
    days: list[HabitStoryDay]
    stages: list[HabitStoryStage]
    continuity: HabitStoryContinuity
    rates: HabitStoryRates
    tiers: HabitStoryTiers
    patterns: HabitStoryPatterns
    logs: list[HabitStoryLog]
    observations: list[str]
    milestones: list[HabitStoryMilestone]
