"""Read-only whole-person calendar and engagement series."""

from datetime import date, datetime

from pydantic import BaseModel, Field


class ArcStage(BaseModel):
    """One canonical stage with an honest, possibly unknown opening date."""

    stage_number: int = Field(ge=1, le=10)
    aspect: str
    weeks: int = Field(ge=1)
    opens_on: date | None
    practice_ask_minutes: float | None


class HabitUnitsDay(BaseModel):
    """Actual units logged on one user-local day, including quiet zero days."""

    date: date
    units: float = Field(ge=0)


class HabitUnitHistory(BaseModel):
    """One measure over the current programme; unlike units stay separate."""

    unit: str
    days: list[HabitUnitsDay]


class HabitBirth(BaseModel):
    """A habit's provenance in this cycle, not a mutation of its stored flag."""

    habit_id: int
    name: str
    icon: str
    week: int | None = Field(
        ge=1,
        le=36,
        description=(
            "Week in this 36-week arc; null for carryovers, unknown anchors, "
            "or births after week 36. Regular births before the anchor use week 1."
        ),
    )
    stage_number: int | None = Field(ge=1, le=10)
    is_carryover: bool = Field(description="The person's explicit bring-along choice.")
    unit_histories: list[HabitUnitHistory] = Field(default_factory=list)


class ProgressArc(BaseModel):
    """The live programme anchor and its ten-stage shape."""

    program_started_at: datetime | None
    cycle_number: int = Field(ge=1)
    current_stage: int = Field(ge=1, le=10)
    current_week: int | None = Field(ge=1, le=36)
    stages: list[ArcStage]
    habit_births: list[HabitBirth]


class RhythmDay(BaseModel):
    """A trailing mean of daily fractions, with the raw daily opportunity pair."""

    date: date
    rate: float = Field(ge=0, le=1)
    daily_met: int = Field(
        ge=0,
        description=(
            "Scheduled habits meeting Low, Clear, or Stretch plus at most one counted practice day."
        ),
    )
    daily_scheduled: int = Field(
        ge=0,
        description="Scheduled habit opportunities plus one when the practice ring is enabled.",
    )
    window_days: int = Field(
        ge=1,
        le=14,
        description="Calendar days in this trailing mean; not a ratio of pooled counts.",
    )


class RestWindow(BaseModel):
    """The inclusive bounds of a quiet stretch after the first four weeks."""

    start: date
    end: date


class ProgressRhythm(BaseModel):
    """The unnamed engagement wave and factual calendar observations."""

    days: list[RhythmDay]
    fullest_fortnight_ending: date | None
    longest_rest: RestWindow | None
    rising_since: date | None


class CycleRate(BaseModel):
    """A stage's habit-day and enabled-practice population in one known cycle."""

    cycle: int = Field(ge=1)
    rate: float = Field(ge=0, le=1)
    scheduled_days: int = Field(ge=0)
    met_days: int = Field(ge=0)


class StageCycleRates(BaseModel):
    """Recorded passes through one canonical stage, in cycle order."""

    stage_number: int = Field(ge=1, le=10)
    rates: list[CycleRate]


class EnergyWeek(BaseModel):
    """A Monday-start local week of persisted completion energy."""

    week_start: date
    net: int


class ProgressEnergy(BaseModel):
    """The ledger's signed weekly sum and its exact formula."""

    weeks: list[EnergyWeek]
    formula: str = "sum(return - cost) over completions"


class ProgressOverviewResponse(BaseModel):
    """Private source series for the Map's optional Progress door."""

    arc: ProgressArc
    rhythm: ProgressRhythm
    cycles: list[StageCycleRates]
    energy: ProgressEnergy
    observations: list[str] = Field(
        default_factory=list,
        description="The rhythm wave's caption, worded from its facts; never a phase name.",
    )
