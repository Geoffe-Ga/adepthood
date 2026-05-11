"""Pure-Python rollup over a user's recent :class:`PracticeSession` rows.

The router fetches the last 60 days of the user's sessions in a single
query and hands them to :func:`build_insights`.  Keeping the aggregator
DB-free keeps it cheap to test (no fixtures), and forces the SQL layer
to stay a thin "select by user and date window".

All week math is performed in the user's timezone so a Pacific user
doesn't see a week-boundary jump at 5 PM Sunday (when UTC rolls over).
``today_in_tz`` and ``to_user_date`` from :mod:`domain.dates` are the
only date helpers used here so the bucket math is consistent with the
rest of the app's calendar logic (BUG-STREAK-002).
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from domain.dates import to_user_date, today_in_tz
from models.practice_session import PracticeSession

# Weekly cadence the spec defines as "meeting the practice goal" (≥ 4 sessions
# in the user's local calendar week).
WEEKLY_TARGET_SESSIONS = 4

# Rolling window for the weekly bar chart.  ``8`` is the spec value —
# enough to spot a 6-week streak with a soft on-ramp at the head of the
# series.
WEEKLY_HISTORY_WEEKS = 8

# 30-day rolling window for total / average / per-mode rollups.  Keep
# this as a named constant so the SQL window in the router stays in lock-step.
ROLLING_30D_WINDOW_DAYS = 30


@dataclass(frozen=True, slots=True)
class WeeklyCount:
    """Sessions completed in the calendar week that starts on ``week_start``."""

    week_start: date
    count: int


@dataclass(frozen=True, slots=True)
class PracticeInsights:
    """Insights rollup payload returned by :func:`build_insights`.

    Mirrors the wire schema in
    :class:`schemas.practice.PracticeInsightsResponse` so the router can
    re-shape with a single ``model_validate`` call.
    """

    weekly_counts: list[WeeklyCount]
    streak_weeks: int
    total_minutes_30d: float
    avg_duration_minutes_30d: float | None
    per_mode_counts: dict[str, int]
    last_insight: str | None


def _as_utc_aware(moment: datetime) -> datetime:
    """Return ``moment`` re-anchored as UTC if it arrived naive.

    Production Postgres ``timestamptz`` columns yield tz-aware datetimes,
    but SQLite (the test DB) silently drops the tzinfo on read.  The
    stored value is always the UTC instant we wrote, so re-attaching UTC
    is correct rather than a band-aid.  ``to_user_date`` raises on naive
    input — funneling every session timestamp through this helper keeps
    that strict guard intact without forcing every test fixture to know
    the storage-layer quirk.
    """
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment


def _monday_of(day: date) -> date:
    """Return the Monday on or before ``day``.

    Sessions are bucketed by ISO week (Monday→Sunday) so the boundary
    matches the practice-cadence rule users see in habit tooling
    elsewhere in the app.
    """
    return day - timedelta(days=day.weekday())


def _local_week_starts(today: date, *, history_weeks: int) -> list[date]:
    """Return the ``history_weeks`` Monday-start dates ending at this week.

    Ordered oldest-first so the chart reads left-to-right without the
    consumer having to reverse it.
    """
    current_monday = _monday_of(today)
    return [current_monday - timedelta(weeks=history_weeks - 1 - i) for i in range(history_weeks)]


def _bucket_by_week(
    sessions: Iterable[PracticeSession],
    *,
    tz: str | None,
) -> Counter[date]:
    """Count sessions per Monday-start week in the user's timezone."""
    buckets: Counter[date] = Counter()
    for session in sessions:
        if session.duration_minutes <= 0:
            # Spec: partial sessions count toward weekly totals *iff* duration > 0.
            # Zero-duration aborts don't move the cadence needle.
            continue
        local_day = to_user_date(tz, _as_utc_aware(session.timestamp))
        buckets[_monday_of(local_day)] += 1
    return buckets


def _streak_weeks(
    weekly_counts: list[WeeklyCount],
    *,
    target: int = WEEKLY_TARGET_SESSIONS,
) -> int:
    """How many consecutive weeks ending now have hit ``target`` sessions.

    The current week counts even if it's still in progress — the spec's
    "4 x/week for 3 weeks running" UX shows users their momentum as it
    accrues, not after a week boundary.
    """
    streak = 0
    for bucket in reversed(weekly_counts):
        if bucket.count >= target:
            streak += 1
        else:
            break
    return streak


def _is_in_30d_window(session: PracticeSession, today: date, tz: str | None) -> bool:
    """``True`` if the session's local date is within the rolling 30-day window."""
    local_day = to_user_date(tz, _as_utc_aware(session.timestamp))
    return today - timedelta(days=ROLLING_30D_WINDOW_DAYS) <= local_day <= today


def _rolling_30d_stats(
    sessions: Iterable[PracticeSession],
    today: date,
    tz: str | None,
) -> tuple[float, float | None, dict[str, int]]:
    """Total minutes, average duration, and per-mode counts over the last 30 days.

    Mirrors the ``duration_minutes <= 0`` guard from :func:`_bucket_by_week`
    so a quick-cancel session never inflates ``per_mode_counts`` or drags
    the average toward zero while the weekly cadence is unchanged.
    """
    durations: list[float] = []
    per_mode: Counter[str] = Counter()
    for session in sessions:
        if session.duration_minutes <= 0:
            continue
        if not _is_in_30d_window(session, today, tz):
            continue
        durations.append(session.duration_minutes)
        per_mode[session.mode] += 1
    total = float(sum(durations))
    average = total / len(durations) if durations else None
    return total, average, dict(per_mode)


def _last_insight(sessions: Iterable[PracticeSession]) -> str | None:
    """Most recent non-null ``insight`` across all the user's sessions.

    ``sessions`` is assumed unsorted; we scan and pick the maximum
    timestamp via :func:`max` so the caller doesn't have to pre-sort.
    Naive SQLite timestamps are normalized to UTC so the comparison key
    never mixes aware/naive datetimes.

    The router supplies the full 60-day fetch window — wider than the
    30-day rollup — on purpose: a user who took a multi-week pause should
    still see their last takeaway when they return rather than a blank
    card.  Narrowing this to 30 days would silently hide insights during
    onboarding-back-from-lull.
    """
    with_insight = [s for s in sessions if s.insight is not None]
    if not with_insight:
        return None
    latest = max(with_insight, key=lambda s: _as_utc_aware(s.timestamp))
    return latest.insight


def build_insights(
    sessions: Iterable[PracticeSession],
    *,
    tz: str | None,
) -> PracticeInsights:
    """Aggregate a list of session rows into the rollup payload.

    ``sessions`` may be any iterable (the router passes a list of ORM
    rows); the aggregator never re-queries.  ``tz`` accepts the same
    shapes as :mod:`domain.dates` so callers can pass the raw
    ``User.timezone`` string or the loaded ORM row.
    """
    materialized = list(sessions)

    today = today_in_tz(tz)
    week_starts = _local_week_starts(today, history_weeks=WEEKLY_HISTORY_WEEKS)
    bucket_counts = _bucket_by_week(materialized, tz=tz)
    weekly_counts = [
        WeeklyCount(week_start=ws, count=bucket_counts.get(ws, 0)) for ws in week_starts
    ]

    total_30d, avg_30d, per_mode = _rolling_30d_stats(materialized, today, tz)

    return PracticeInsights(
        weekly_counts=weekly_counts,
        streak_weeks=_streak_weeks(weekly_counts),
        total_minutes_30d=total_30d,
        avg_duration_minutes_30d=avg_30d,
        per_mode_counts=per_mode,
        last_insight=_last_insight(materialized),
    )
