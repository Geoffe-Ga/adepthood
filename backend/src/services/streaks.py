"""Streak and milestone services — DB-aware wrappers over pure domain logic.

Routers call these helpers instead of computing streaks inline so the same
logic can be reused from background jobs, admin tools, and tests without
needing HTTP fixtures.  Pure functions stay in :mod:`domain.streaks` and
:mod:`domain.milestones` so they remain trivially unit-testable; this module
only adds the DB-query layer that composes them into a request-ready
result.

Streak dates are reduced to *user-local* calendar days (BUG-STREAK-002).
Storing timestamps in UTC and then bucketing with ``.date()`` would tick
streaks over at the server's midnight rather than the user's, breaking
West-Coast users by 7-8 hours every day.  All conversion goes through
:func:`domain.dates.to_user_date`, which preserves DST jumps and never
silently coerces naive datetimes.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.dates import to_user_date, today_in_tz
from domain.streaks import update_streak
from models.goal_completion import GoalCompletion
from schemas.milestone import Milestone

__all__ = [
    "check_milestones",
    "compute_consecutive_streak",
    "compute_habit_streak",
    "update_streak",
]


def _to_user_date(ts: datetime | str, user_timezone: str) -> date:
    """Bucket a stored timestamp into the user's local calendar day.

    Accepts either a :class:`datetime` (the production path through
    Postgres ``timestamptz`` columns) or an ISO-8601 string (SQLite test
    DB returns these for ``DateTime(timezone=True)`` columns since
    SQLite has no native tz type).  Naive datetimes are treated as UTC
    so SQLite-stored values still convert correctly; this is the one
    place where naive coercion is acceptable because the source column
    is declared timezone-aware and SQLite is just lying about its
    storage.

    Narrowing the type to ``datetime | str`` (rather than ``object``)
    lets mypy reject bad call sites at the boundary; an unexpected
    ``None`` from an ORM-column edge case used to fall through to
    ``str()`` and raise an obscure ``ValueError`` from
    ``fromisoformat``.
    """
    if isinstance(ts, datetime):
        moment = ts if ts.tzinfo is not None else ts.replace(tzinfo=UTC)
    else:
        # ISO-8601 string from SQLite; the column is timezone-aware so
        # the format is always "YYYY-MM-DD HH:MM:SS[.fff][+HH:MM]".
        # ``fromisoformat`` accepts that since Python 3.11.
        parsed = datetime.fromisoformat(ts)
        moment = parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)
    return to_user_date(user_timezone, moment)


def _count_consecutive_days(sorted_days: list[date], day_ok: dict[date, bool]) -> int:
    """Count consecutive days from most recent where ``day_ok`` is True.

    ``sorted_days`` MUST be sorted descending (most recent first); the
    consecutive-day check ``(sorted_days[i - 1] - day).days == 1`` only
    holds for that ordering, and a future caller passing ascending
    dates would silently return the wrong streak length without this
    invariant being documented.
    """
    streak = 0
    for i, day in enumerate(sorted_days):
        if not day_ok[day]:
            break
        if i > 0 and (sorted_days[i - 1] - day).days != 1:
            break
        streak += 1
    return streak


def _is_chain_stale(sorted_days_desc: list[date], user_timezone: str) -> bool:
    """Return True when the most-recent completion day is older than yesterday.

    Mirrors the frontend ``streakFromCompletions`` recency gate so both
    sides of the wire agree: if the user has not completed today *or*
    yesterday, the chain is considered broken and the streak is 0.

    The "yesterday" grace window prevents the UI from briefly flashing
    "streak lost" between local midnight and the user's first
    completion of the day; one stale day is forgiven, two is not.
    """
    if not sorted_days_desc:
        return True
    today = today_in_tz(user_timezone)
    yesterday = today - timedelta(days=1)
    return sorted_days_desc[0] < yesterday


async def compute_consecutive_streak(
    session: AsyncSession,
    goal_id: int,
    user_id: int,
    user_timezone: str = "UTC",
) -> int:
    """Count consecutive *days* with completed check-ins for a goal.

    Collapses multiple rows on the same calendar day into a single day,
    fixing BUG-HABITS-011 where the old code counted rows instead of
    unique days.  ``user_timezone`` selects which calendar's "day"
    boundary applies (BUG-STREAK-002); routers should pass
    :func:`services.users.get_user_timezone` so streaks tick over at the
    user's midnight rather than UTC's.
    """
    rows = await session.execute(
        select(GoalCompletion.timestamp, GoalCompletion.completed_units)
        .where(GoalCompletion.goal_id == goal_id, GoalCompletion.user_id == user_id)
        .order_by(col(GoalCompletion.timestamp).desc())
    )

    day_totals: dict[date, float] = {}
    for ts, units in rows:
        day = _to_user_date(ts, user_timezone)
        day_totals[day] = day_totals.get(day, 0.0) + units

    sorted_days = sorted(day_totals, reverse=True)
    # Mirror the frontend's recency gate so a stale chain reports 0 here
    # too.  ``compute_consecutive_streak`` is also called from the
    # check-in path which inserts today's completion before reading,
    # so the gate is a no-op there; the win is preventing surprise
    # divergence from any future caller.
    if _is_chain_stale(sorted_days, user_timezone):
        return 0
    day_ok = {d: day_totals[d] > 0 for d in sorted_days}
    return _count_consecutive_days(sorted_days, day_ok)


def _completed_user_dates(
    completions: Sequence[GoalCompletion],
    user_timezone: str,
) -> set[date]:
    """Return the set of user-local calendar days where the goal was met.

    Split out so :func:`compute_habit_streak` stays at xenon rank A; the
    inner generator + filter pushed the parent block over the threshold.
    """
    return {_to_user_date(c.timestamp, user_timezone) for c in completions if c.completed_units > 0}


def compute_habit_streak(
    completions: Sequence[GoalCompletion],
    user_timezone: str = "UTC",
) -> int:
    """Compute current consecutive-day streak from in-memory completions.

    Used by ``GET /habits`` to populate streak without a per-goal DB query.
    ``user_timezone`` mirrors the database path's parameter
    (BUG-STREAK-002) — both call sites must agree or the same goal would
    show two different streak counts depending on whether it was loaded
    via the in-memory or per-goal path.

    Also enforces the same recency gate the frontend
    ``streakFromCompletions`` helper uses (BUG-FE-HABIT-207): if the most
    recent completion is older than yesterday in the user's calendar,
    the streak is broken and the helper returns 0.  Without the gate the
    Habits list endpoint would advertise a non-zero "10-day streak 🔥"
    while the stats overlay (which used the frontend helper) showed 0
    after a missed day -- exactly the visible discrepancy this gate
    prevents.
    """
    dates = _completed_user_dates(completions, user_timezone)
    if not dates:
        return 0
    sorted_dates = sorted(dates, reverse=True)
    if _is_chain_stale(sorted_dates, user_timezone):
        return 0
    day_ok = dict.fromkeys(sorted_dates, True)
    return _count_consecutive_days(sorted_dates, day_ok)


def check_milestones(
    new_streak: int,
    thresholds: list[int],
    old_streak: int = 0,
) -> list[Milestone]:
    """Return milestones *newly crossed* between ``old_streak`` and ``new_streak``.

    Only thresholds where ``old_streak < t <= new_streak`` are returned,
    preventing duplicate milestone toasts on retries (BUG-HABITS-008).
    """
    reached = [t for t in thresholds if old_streak < t <= new_streak]
    return [Milestone(threshold=t) for t in reached]
