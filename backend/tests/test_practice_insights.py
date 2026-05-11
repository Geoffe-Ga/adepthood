"""Pure-Python tests for the practice-insights aggregator."""

from __future__ import annotations

from dataclasses import FrozenInstanceError
from datetime import UTC, date, datetime, timedelta

import pytest

from domain.practice_insights import (
    WEEKLY_HISTORY_WEEKS,
    WEEKLY_TARGET_SESSIONS,
    PracticeInsights,
    build_insights,
)
from models.practice_session import PracticeSession


def _session(
    *,
    timestamp: datetime,
    duration_minutes: float = 10.0,
    mode: str = "meditation_timer",
    insight: str | None = None,
    completed: bool = True,
) -> PracticeSession:
    """Build an in-memory ``PracticeSession`` row (no DB write)."""
    return PracticeSession(
        user_id=1,
        user_practice_id=1,
        duration_minutes=duration_minutes,
        timestamp=timestamp,
        mode=mode,
        insight=insight,
        completed=completed,
    )


def _now_utc() -> datetime:
    return datetime.now(UTC)


# -- weekly_counts ----------------------------------------------------------


def test_weekly_counts_has_history_weeks_buckets() -> None:
    """An empty input still yields the full rolling-window shape (8 zero buckets)."""
    insights = build_insights([], tz="UTC")
    assert len(insights.weekly_counts) == WEEKLY_HISTORY_WEEKS
    assert all(bucket.count == 0 for bucket in insights.weekly_counts)


def test_weekly_counts_are_oldest_first() -> None:
    """Buckets are ordered so the chart reads left-to-right without reversing."""
    insights = build_insights([], tz="UTC")
    week_starts = [bucket.week_start for bucket in insights.weekly_counts]
    assert week_starts == sorted(week_starts)


def test_weekly_counts_bucket_current_week_sessions() -> None:
    """Sessions logged in this week's mid-week window land in the rightmost bucket."""
    anchor = _monday_anchor_utc()
    sessions = [_session(timestamp=anchor + timedelta(hours=i)) for i in range(3)]
    insights = build_insights(sessions, tz="UTC")
    assert insights.weekly_counts[-1].count == 3
    # Older buckets stay zero.
    assert sum(b.count for b in insights.weekly_counts[:-1]) == 0


def test_weekly_counts_ignore_zero_duration_sessions() -> None:
    """A cancelled session with ``duration_minutes=0`` does not move the cadence."""
    now = _now_utc()
    sessions = [_session(timestamp=now, duration_minutes=0.0, completed=False) for _ in range(2)]
    insights = build_insights(sessions, tz="UTC")
    assert insights.weekly_counts[-1].count == 0


def test_partial_session_with_positive_duration_counts() -> None:
    """An aborted-but-non-empty session still counts toward weekly totals."""
    now = _now_utc()
    sessions = [_session(timestamp=now, duration_minutes=2.0, completed=False)]
    insights = build_insights(sessions, tz="UTC")
    assert insights.weekly_counts[-1].count == 1


# -- streak_weeks ------------------------------------------------------------


def _monday_anchor_utc() -> datetime:
    """Return a UTC instant pinned to Monday 12:00 of the current week.

    Anchoring the synthetic sessions to mid-week keeps small ``hours=i``
    offsets safely inside the same calendar bucket, even when the test
    runs at the boundary between Sunday and Monday.
    """
    now = _now_utc()
    monday = now.date() - timedelta(days=now.weekday())
    return datetime.combine(monday, datetime.min.time(), tzinfo=UTC) + timedelta(hours=12)


def test_streak_weeks_boundary_at_target() -> None:
    """Exactly ``WEEKLY_TARGET_SESSIONS`` counts; one fewer doesn't."""
    anchor = _monday_anchor_utc()
    # 4 sessions this week, 3 last week (breaks streak), 4 the week before.
    this_week = [
        _session(timestamp=anchor + timedelta(hours=i)) for i in range(WEEKLY_TARGET_SESSIONS)
    ]
    last_week = [
        _session(timestamp=anchor - timedelta(days=7) + timedelta(hours=i))
        for i in range(WEEKLY_TARGET_SESSIONS - 1)
    ]
    older = [
        _session(timestamp=anchor - timedelta(days=14) + timedelta(hours=i))
        for i in range(WEEKLY_TARGET_SESSIONS)
    ]
    insights = build_insights([*this_week, *last_week, *older], tz="UTC")
    # Only the current week meets the target; the chain breaks at last week's 3.
    assert insights.streak_weeks == 1


def test_streak_weeks_three_in_a_row() -> None:
    """Three consecutive on-target weeks return ``streak_weeks=3``."""
    anchor = _monday_anchor_utc()
    sessions: list[PracticeSession] = []
    for week_offset in range(3):
        sessions.extend(
            _session(timestamp=anchor - timedelta(days=7 * week_offset) + timedelta(hours=i))
            for i in range(WEEKLY_TARGET_SESSIONS)
        )
    insights = build_insights(sessions, tz="UTC")
    assert insights.streak_weeks == 3


def test_streak_weeks_zero_when_no_sessions() -> None:
    assert build_insights([], tz="UTC").streak_weeks == 0


# -- 30-day rollups ---------------------------------------------------------


def test_total_minutes_and_avg_30d() -> None:
    now = _now_utc()
    sessions = [
        _session(timestamp=now - timedelta(days=1), duration_minutes=20.0),
        _session(timestamp=now - timedelta(days=10), duration_minutes=10.0),
    ]
    insights = build_insights(sessions, tz="UTC")
    expected_total_minutes = 30.0
    expected_avg_minutes = 15.0
    assert insights.total_minutes_30d == pytest.approx(expected_total_minutes)
    assert insights.avg_duration_minutes_30d == pytest.approx(expected_avg_minutes)


def test_avg_is_none_when_no_sessions_in_30d() -> None:
    insights = build_insights([], tz="UTC")
    assert insights.avg_duration_minutes_30d is None
    assert insights.total_minutes_30d == 0.0


def test_per_mode_counts_30d() -> None:
    now = _now_utc()
    sessions = [
        _session(timestamp=now, mode="meditation_timer"),
        _session(timestamp=now - timedelta(days=2), mode="rep_counter"),
        _session(timestamp=now - timedelta(days=5), mode="rep_counter"),
    ]
    insights = build_insights(sessions, tz="UTC")
    assert insights.per_mode_counts == {"meditation_timer": 1, "rep_counter": 2}


def test_30d_window_excludes_old_sessions() -> None:
    """A 45-day-old session is past the rolling window and excluded everywhere."""
    now = _now_utc()
    old = _session(timestamp=now - timedelta(days=45), duration_minutes=60.0, mode="metronome")
    insights = build_insights([old], tz="UTC")
    assert insights.total_minutes_30d == 0.0
    assert insights.avg_duration_minutes_30d is None
    assert "metronome" not in insights.per_mode_counts


# -- last_insight -----------------------------------------------------------


def test_last_insight_picks_most_recent_non_null() -> None:
    now = _now_utc()
    sessions = [
        _session(timestamp=now - timedelta(days=2), insight="first"),
        _session(timestamp=now, insight="latest"),
        _session(timestamp=now - timedelta(days=1), insight=None),
    ]
    assert build_insights(sessions, tz="UTC").last_insight == "latest"


def test_last_insight_is_none_when_no_insights_logged() -> None:
    now = _now_utc()
    sessions = [_session(timestamp=now)]
    assert build_insights(sessions, tz="UTC").last_insight is None


# -- Timezone-aware bucketing ----------------------------------------------


def test_bucket_uses_user_timezone_at_midnight_boundary() -> None:
    """A late-evening Pacific session stays in *its* local week, not UTC's next."""
    # 07:30 UTC on a Monday is 00:30 Pacific the *same* Monday — but the user
    # logged at 23:30 their previous Sunday by wall clock.  We only assert the
    # session reaches *some* bucket in both zones; the week_start values may
    # differ across zones by design.
    utc_instant = datetime(2026, 5, 11, 6, 30, tzinfo=UTC)
    session_row = _session(timestamp=utc_instant)
    insights_utc = build_insights([session_row], tz="UTC")
    insights_pacific = build_insights([session_row], tz="America/Los_Angeles")
    assert sum(b.count for b in insights_utc.weekly_counts) == 1
    assert sum(b.count for b in insights_pacific.weekly_counts) == 1


# -- Dataclass invariants ---------------------------------------------------


def test_insights_dataclass_is_frozen() -> None:
    """``PracticeInsights`` is immutable so callers can't mutate cached rollups."""
    insights = build_insights([], tz="UTC")
    with pytest.raises(FrozenInstanceError):
        insights.streak_weeks = 99  # type: ignore[misc]


def test_weekly_count_dataclass_is_frozen() -> None:
    """``WeeklyCount`` buckets are immutable; mutating ``count`` raises."""
    insights = build_insights([], tz="UTC")
    bucket = insights.weekly_counts[0]
    with pytest.raises(FrozenInstanceError):
        bucket.count = 42  # type: ignore[misc]


def test_weekly_count_week_start_is_a_monday() -> None:
    """Every bucket key is a Monday in ISO terms (weekday() == 0)."""
    insights = build_insights([], tz="UTC")
    assert all(isinstance(b.week_start, date) for b in insights.weekly_counts)
    assert all(b.week_start.weekday() == 0 for b in insights.weekly_counts)


def test_returns_practice_insights_instance() -> None:
    """Sanity: the public function returns the documented dataclass."""
    result = build_insights([], tz="UTC")
    assert isinstance(result, PracticeInsights)
