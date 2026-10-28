"""Pure lifetime Practice Story rollups over the owner's selected-practice history.

Every figure uses the positive-duration rule settled in ``practice_stats``.
The router supplies both the lifetime rows and the known stage window (or an
adoption fallback); no database or ownership decision lives in this module.
"""

import dataclasses
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, replace
from datetime import date, datetime

from domain.dates import ensure_aware, to_user_date, today_in_tz
from domain.observations import (
    Milestone,
    PracticeFacts,
    practice_milestones,
    practice_observations,
)
from domain.practice_insights import (
    WEEKLY_HISTORY_WEEKS,
    WEEKLY_TARGET_SESSIONS,
    WeeklyCount,
    local_week_starts,
    monday_of,
)
from domain.practice_stats import MIN_COUNTED_DURATION_MINUTES, compute_practice_stats
from domain.time_of_day import time_of_day
from models.practice_session import PracticeSession

RECENT_SITS_LIMIT = 30
METADATA_TOTAL_FIELDS = ("rep_count", "intervals_struck", "bells_struck", "items_completed")


@dataclass(frozen=True, slots=True)
class RecentSit:
    """One chronological mark in the last thirty counted sits."""

    timestamp: datetime
    duration_minutes: float
    completed: bool
    mode: str


@dataclass(frozen=True, slots=True)
class PracticeStageScope:
    """Known half-open stage window, or the adoption fallback when no anchor exists."""

    selection_id: int
    window: tuple[datetime, datetime] | None = None


@dataclass(frozen=True, slots=True)
class PracticeStory:
    """All figures drawn by the Practice Story, with denominators kept explicit."""

    total_minutes: float
    total_sessions: int
    weekly: list[WeeklyCount]
    weekly_target: int
    recent_sits: list[RecentSit]
    time_of_day: dict[str, int]
    modes: dict[str, int]
    stage_ask_minutes: float
    stage_average_minutes: float | None
    stage_session_count: int
    stage_partial_sessions: int
    partial_sessions: int
    insight_count: int
    last_insight: str | None
    last_insight_timestamp: datetime | None
    mode_totals: dict[str, float]
    first_session_on: date | None
    observations: list[str] = dataclasses.field(default_factory=list)
    milestones: list[Milestone] = dataclasses.field(default_factory=list)


def _weekly(sessions: list[PracticeSession], tz: str | None) -> list[WeeklyCount]:
    """Keep all eight Monday-start buckets, including weeks with no sits."""
    counts = Counter(monday_of(to_user_date(tz, ensure_aware(row.timestamp))) for row in sessions)
    starts = local_week_starts(today_in_tz(tz), history_weeks=WEEKLY_HISTORY_WEEKS)
    return [WeeklyCount(week_start=start, count=counts[start]) for start in starts]


def _time_buckets(sessions: list[PracticeSession], tz: str | None) -> dict[str, int]:
    """Include quiet time buckets so the client never invents a missing bar."""
    counts: Counter[str] = Counter(time_of_day(row.timestamp, tz) for row in sessions)
    return {bucket: counts[bucket] for bucket in ("dawn", "day", "dusk", "night")}


def _numeric_total(value: object) -> float | None:
    """Ignore malformed legacy metadata rather than coercing strings or booleans."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def _metadata_measurements(metadata: dict[str, object]) -> dict[str, float]:
    """Extract the documented numeric counters and the number of senses completed."""
    measurements: dict[str, float] = {}
    for field in METADATA_TOTAL_FIELDS:
        value = _numeric_total(metadata.get(field))
        if value is not None:
            measurements[field] = value
    senses = metadata.get("senses_completed")
    if isinstance(senses, list):
        measurements["senses_completed"] = float(len(senses))
    return measurements


def _mode_totals(sessions: list[PracticeSession]) -> dict[str, float]:
    """Sum only documented measurements, never private or unrelated metadata."""
    totals: defaultdict[str, float] = defaultdict(float)
    for row in sessions:
        for field, value in _metadata_measurements(row.mode_metadata or {}).items():
            totals[field] += value
    return dict(totals)


def _windowed_sits(
    sessions: list[PracticeSession], window: tuple[datetime, datetime]
) -> list[PracticeSession]:
    """Select rows within the known half-open stage window."""
    start, end = window
    return [row for row in sessions if start <= ensure_aware(row.timestamp) < end]


def _stage_sits(
    sessions: list[PracticeSession], scope: PracticeStageScope
) -> list[PracticeSession]:
    """Use recorded stage bounds; an unknown calendar falls back to one adoption."""
    if scope.window is None:
        return [row for row in sessions if row.user_practice_id == scope.selection_id]
    return _windowed_sits(sessions, scope.window)


def _counted_sits(sessions: Iterable[PracticeSession]) -> list[PracticeSession]:
    """Materialize the shared counted population in chronological order."""
    return sorted(
        (row for row in sessions if row.duration_minutes > MIN_COUNTED_DURATION_MINUTES),
        key=lambda row: ensure_aware(row.timestamp),
    )


def _recent_sits(sessions: list[PracticeSession]) -> list[RecentSit]:
    """Bound the drawn marks without truncating the lifetime facts."""
    return [
        RecentSit(ensure_aware(row.timestamp), row.duration_minutes, row.completed, row.mode)
        for row in sessions[-RECENT_SITS_LIMIT:]
    ]


def _insights(sessions: list[PracticeSession]) -> tuple[int, str | None, datetime | None]:
    """Keep the newest takeaway and its date, including takeaways older than thirty sits."""
    with_insight = [row for row in sessions if row.insight is not None]
    if not with_insight:
        return 0, None, None
    last = with_insight[-1]
    return len(with_insight), last.insight, ensure_aware(last.timestamp)


def _partial_sessions(sessions: list[PracticeSession]) -> int:
    """A positive-duration partial sit remains part of the practice's time."""
    return sum(not row.completed for row in sessions)


def _modes(sessions: list[PracticeSession]) -> dict[str, int]:
    """Count each stored mode without relabeling historical sessions."""
    return dict(Counter(row.mode for row in sessions))


def _average(sessions: list[PracticeSession]) -> float | None:
    """An empty stage has no measured sitting length, rather than a zero-minute mean."""
    stats = compute_practice_stats(sessions)
    return stats.total_minutes / stats.total_sessions if stats.total_sessions else None


def _first_session_on(sessions: list[PracticeSession], tz: str | None) -> date | None:
    """Name the first counted sit by the calendar date the person lived."""
    return to_user_date(tz, ensure_aware(sessions[0].timestamp)) if sessions else None


def build_practice_story(
    sessions: Iterable[PracticeSession],
    *,
    tz: str | None,
    stage_ask_minutes: float,
    stage_scope: PracticeStageScope,
    stage_name: str | None = None,
) -> PracticeStory:
    """Describe one practice's lifetime, its recent cadence, and the requested stage."""
    counted = _counted_sits(sessions)
    story = _figures(counted, tz=tz, stage_ask_minutes=stage_ask_minutes, stage_scope=stage_scope)
    return _with_observations(story, counted, tz=tz, stage_name=stage_name)


def _with_observations(
    story: PracticeStory, counted: list[PracticeSession], *, tz: str | None, stage_name: str | None
) -> PracticeStory:
    """Add the sentences and dated milestones (#3525) the figures support."""
    facts = PracticeFacts(
        total_minutes=story.total_minutes,
        total_sessions=story.total_sessions,
        stage_ask_minutes=story.stage_ask_minutes,
        stage_average_minutes=story.stage_average_minutes,
        time_of_day=story.time_of_day,
        stage_name=stage_name,
    )
    sits = [(row.timestamp, row.duration_minutes) for row in counted]
    return replace(
        story,
        observations=practice_observations(facts),
        milestones=practice_milestones(sits, tz=tz),
    )


def _figures(
    counted: list[PracticeSession],
    *,
    tz: str | None,
    stage_ask_minutes: float,
    stage_scope: PracticeStageScope,
) -> PracticeStory:
    """Every figure the Story draws, over the counted sits."""
    totals = compute_practice_stats(counted)
    insight_count, last_insight, last_insight_timestamp = _insights(counted)
    stage = _stage_sits(counted, stage_scope)
    return PracticeStory(
        total_minutes=totals.total_minutes,
        total_sessions=totals.total_sessions,
        weekly=_weekly(counted, tz),
        weekly_target=WEEKLY_TARGET_SESSIONS,
        recent_sits=_recent_sits(counted),
        time_of_day=_time_buckets(counted, tz),
        modes=_modes(counted),
        stage_ask_minutes=stage_ask_minutes,
        stage_average_minutes=_average(stage),
        stage_session_count=len(stage),
        stage_partial_sessions=_partial_sessions(stage),
        partial_sessions=_partial_sessions(counted),
        insight_count=insight_count,
        last_insight=last_insight,
        last_insight_timestamp=last_insight_timestamp,
        mode_totals=_mode_totals(counted),
        first_session_on=_first_session_on(counted, tz),
    )
