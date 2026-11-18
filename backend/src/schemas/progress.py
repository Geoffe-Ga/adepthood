"""Read-only whole-person calendar and engagement series."""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

from models.program_pass import PassOrigin

#: ``pending`` -- starts on a later day; ``live`` -- running now; ``ended`` -- closed.
PassState = Literal["pending", "live", "ended"]


class ArcStage(BaseModel):
    """One canonical stage with an honest, possibly unknown opening date."""

    stage_number: int = Field(ge=1, le=10)
    aspect: str
    weeks: int = Field(ge=1)
    opens_on: date | None
    practice_ask_minutes: float | None


class HabitUnitsDay(BaseModel):
    """Units logged on one user-local day and the trailing seven-day mean."""

    date: date
    units: float = Field(ge=0)
    average: float = Field(
        ge=0,
        description="Mean daily units over this day and up to six before it in this pass.",
    )


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


class PassMarker(BaseModel):
    """A habit's most recent unlock in one pass, at the number it carried then."""

    habit_id: int
    name: str
    icon: str
    program_number: int = Field(
        ge=1, description="The habit's program number stored on that unlock event."
    )
    week: int = Field(
        ge=1, le=36, description="Week of the unlock, counted from this pass's own start."
    )
    unlocked_on: date = Field(description="The account-zone day of the unlock.")
    currently_locked: bool = Field(
        description=(
            "Ended pass: the habit's latest event in this pass is a re-lock "
            "(locked at the pass's end). Live pass: that, or the habit is locked now."
        )
    )


class ArcPass(BaseModel):
    """One recorded pass through the ten stages, measured from its own start."""

    pass_number: int = Field(ge=1)
    started_on: date
    ended_on: date | None = Field(
        description="The last day the pass ran; null while it is live or pending."
    )
    origin: PassOrigin
    state: PassState = Field(
        description="pending: starts on a later day; live: running now; ended: closed."
    )
    days_until_start: int = Field(ge=0, description="Whole days until a pending pass begins.")
    reached_stage: int | None = Field(
        ge=1,
        le=10,
        description="Stage reached; the stage as of today for a live pass; null when pending.",
    )
    reached_week: int | None = Field(
        ge=1,
        le=36,
        description="Week reached; the current week for a live pass; null when pending.",
    )
    completed: bool = Field(description="Ran to the final day of stage 10. Display only.")
    markers: list[PassMarker] = Field(
        description="One per habit unlocked in this pass, ordered by week then program number."
    )


class ProgressArc(BaseModel):
    """The live programme anchor and its ten-stage shape."""

    program_started_at: datetime | None
    cycle_number: int = Field(ge=1)
    current_stage: int = Field(ge=1, le=10)
    current_week: int | None = Field(ge=1, le=36)
    stages: list[ArcStage]
    habit_births: list[HabitBirth]
    passes: list[ArcPass] = Field(
        default_factory=list,
        description=(
            "One entry per pass, oldest first; at most one is pending, and it is last. "
            "Empty with habits off."
        ),
    )


class RhythmDay(BaseModel):
    """The trailing seven days' pooled share of scheduled asks kept."""

    date: date
    rate: float = Field(ge=0, le=1, description="window_met / window_scheduled; 0 when none.")
    daily_met: int = Field(
        ge=0,
        description="Asks kept this day: habits at Low or above, occasions, one counted sit.",
    )
    daily_scheduled: int = Field(
        ge=0,
        description="Asks this day from joined, unlocked habits plus one with the practice ring.",
    )
    window_met: int = Field(ge=0, description="Asks kept over the trailing window.")
    window_scheduled: int = Field(ge=0, description="Asks scheduled over the trailing window.")
    window_days: int = Field(ge=1, le=7, description="Calendar days in the trailing window.")


class RestWindow(BaseModel):
    """The inclusive bounds of a quiet stretch after the first four weeks."""

    start: date
    end: date


class ProgressRhythm(BaseModel):
    """The unnamed engagement wave and factual calendar observations."""

    days: list[RhythmDay]
    fullest_week_ending: date | None
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
