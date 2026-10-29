"""Value-only inputs shared by the progress overview and its rhythm."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING

from domain.constants import STAGE_DURATIONS_DAYS
from domain.dates import ensure_aware, to_user_date
from domain.frequencies import FREQUENCY_COLORS
from domain.streaks import PERIOD_UNITS, PeriodCadence

if TYPE_CHECKING:
    from models.goal import Goal
    from models.goal_completion import GoalCompletion
    from models.habit import Habit
    from models.practice_session import PracticeSession
    from models.stage_progress import StageProgress

TIER_ORDER = ("low", "clear", "stretch")


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
    return next((goal for tier in TIER_ORDER for goal in goals if goal.tier == tier), None)


def effective_goal_target(goal: Goal) -> float:
    """Keep each tier's own effective target, independent of its siblings."""
    return goal.target * goal.frequency if goal.frequency_unit in PERIOD_UNITS else goal.target


def live_anchor(data: OverviewInput) -> datetime | None:
    """Only a persisted live programme anchor can establish calendar provenance."""
    return (
        ensure_aware(data.progress.program_started_at)
        if data.progress and data.progress.program_started_at is not None
        else None
    )


def start_day(data: OverviewInput) -> date | None:
    """Resolve the known anchor in the user's current calendar."""
    anchor = live_anchor(data)
    return to_user_date(data.timezone, anchor) if anchor is not None else None


_STAGE_BY_COLOR = {
    color.casefold(): index for index, color in enumerate(FREQUENCY_COLORS.values(), 1)
}


def stage_number(stage: str) -> int | None:
    """Colour identities are canonical; retain recognized numeric legacy stages."""
    if stage.isdigit():
        value = int(stage)
        return value if 1 <= value <= len(STAGE_DURATIONS_DAYS) else None
    return _STAGE_BY_COLOR.get(" ".join(stage.split()).casefold())


def stage_opens_on(start: date, stage: int) -> date:
    """The local day ``stage`` opens in a pass anchored on ``start``."""
    return start + timedelta(days=sum(STAGE_DURATIONS_DAYS[: stage - 1]))
