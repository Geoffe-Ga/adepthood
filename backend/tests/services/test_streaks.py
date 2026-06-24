"""Unit tests for :mod:`services.streaks` — DB-aware streak + milestone helpers."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from domain import dates as dates_module
from domain.dates import to_user_date
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.user import User
from schemas.milestone import Milestone
from services.streaks import (
    SubtractiveContext,
    check_milestones,
    compute_consecutive_streak,
    compute_habit_streak,
    update_streak,
)


async def _make_goal(session: AsyncSession, user_id: int) -> Goal:
    """Create a habit + goal owned by ``user_id`` and return the persisted goal."""
    habit = Habit(
        name="Meditate",
        icon="meditate",
        start_date=datetime.now(tz=UTC).date(),
        stage="1",
        streak=0,
        energy_cost=1,
        energy_return=2,
        user_id=user_id,
    )
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    assert habit.id is not None

    goal = Goal(
        habit_id=habit.id,
        title="Sit ten minutes",
        tier="clear",
        target=1.0,
        target_unit="minutes",
        frequency=1.0,
        frequency_unit="per_day",
    )
    session.add(goal)
    await session.commit()
    await session.refresh(goal)
    return goal


async def _make_user(session: AsyncSession) -> User:
    # ``password_hash`` is required at the model level (BUG-AUTH-018);
    # streak tests don't authenticate so any non-empty sentinel is fine.
    user = User(email="streaks@example.com", password_hash="x")
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user


def test_check_milestones_returns_only_newly_crossed() -> None:
    """Only thresholds where old < t <= new are returned (BUG-HABITS-008)."""
    assert check_milestones(7, [1, 3, 7, 14], old_streak=6) == [
        Milestone(threshold=7),
    ]


def test_check_milestones_all_new_when_old_is_zero() -> None:
    """With old_streak=0, all reached thresholds are returned."""
    assert check_milestones(7, [1, 3, 7, 14]) == [
        Milestone(threshold=1),
        Milestone(threshold=3),
        Milestone(threshold=7),
    ]


def test_check_milestones_returns_empty_when_none_reached() -> None:
    assert check_milestones(0, [1, 3, 7]) == []


def test_update_streak_is_re_exported_from_service() -> None:
    """``update_streak`` should stay importable from the service layer too."""
    assert update_streak(2, did_check_in=True) == (3, "streak_incremented")
    assert update_streak(99, did_check_in=False) == (0, "streak_reset")


@pytest.mark.asyncio
async def test_compute_consecutive_streak_counts_unique_days(
    db_session: AsyncSession,
) -> None:
    """Completions on consecutive days contribute to the streak (BUG-HABITS-011)."""
    user = await _make_user(db_session)
    assert user.id is not None
    goal = await _make_goal(db_session, user.id)
    assert goal.id is not None

    now = datetime.now(UTC)
    for days_ago in range(3):
        db_session.add(
            GoalCompletion(
                goal_id=goal.id,
                user_id=user.id,
                completed_units=goal.target,
                timestamp=now - timedelta(days=days_ago),
            )
        )
    await db_session.commit()

    assert await compute_consecutive_streak(db_session, goal.id, user.id) == 3


@pytest.mark.asyncio
async def test_compute_consecutive_streak_collapses_same_day_rows(
    db_session: AsyncSession,
) -> None:
    """Multiple completions on the same day count as one streak day."""
    user = await _make_user(db_session)
    assert user.id is not None
    goal = await _make_goal(db_session, user.id)
    assert goal.id is not None

    for _ in range(3):
        db_session.add(
            GoalCompletion(goal_id=goal.id, user_id=user.id, completed_units=goal.target)
        )
    await db_session.commit()

    assert await compute_consecutive_streak(db_session, goal.id, user.id) == 1


@pytest.mark.asyncio
async def test_compute_consecutive_streak_resets_on_most_recent_miss(
    db_session: AsyncSession,
) -> None:
    """A miss day after completions zeros the reported streak."""
    user = await _make_user(db_session)
    assert user.id is not None
    goal = await _make_goal(db_session, user.id)
    assert goal.id is not None

    now = datetime.now(UTC)
    db_session.add(
        GoalCompletion(
            goal_id=goal.id,
            user_id=user.id,
            completed_units=goal.target,
            timestamp=now - timedelta(days=1),
        )
    )
    await db_session.commit()
    db_session.add(
        GoalCompletion(goal_id=goal.id, user_id=user.id, completed_units=0, timestamp=now)
    )
    await db_session.commit()

    assert await compute_consecutive_streak(db_session, goal.id, user.id) == 0


@pytest.mark.asyncio
async def test_compute_consecutive_streak_returns_zero_for_new_goal(
    db_session: AsyncSession,
) -> None:
    user = await _make_user(db_session)
    assert user.id is not None
    goal = await _make_goal(db_session, user.id)
    assert goal.id is not None

    assert await compute_consecutive_streak(db_session, goal.id, user.id) == 0


# ── BUG-STREAK-002: streak counted in user TZ, not server UTC ──────────────

# A fixed "now" one evening after the BUG-STREAK-002 completions.  The streak
# service walks backwards from ``today_in_tz(...)`` (which funnels through
# ``domain.dates.now_in_tz``), so a test with hardcoded completion dates only
# passes while the *real* system clock sits within a day of those dates.
# Freezing the single clock seam makes such a test deterministic on any date.
_FROZEN_NOW = datetime(2026, 6, 15, 20, 0, tzinfo=UTC)


@pytest.fixture
def frozen_streak_clock(monkeypatch: pytest.MonkeyPatch) -> datetime:
    """Pin ``domain.dates.now_in_tz`` to :data:`_FROZEN_NOW` for the test.

    ``today_in_tz`` resolves ``now_in_tz`` from the ``domain.dates`` module
    globals at call time, so replacing that one attribute freezes the clock for
    every streak helper without touching their call sites.  The fake mirrors the
    real signature (returns a tz-aware instant in the requested zone); the streak
    tests only ever pass IANA strings, so a string-or-UTC resolver is sufficient.
    """

    def _fake_now_in_tz(user_or_tz: object) -> datetime:
        zone = user_or_tz if isinstance(user_or_tz, str) else "UTC"
        return _FROZEN_NOW.astimezone(ZoneInfo(zone))

    monkeypatch.setattr(dates_module, "now_in_tz", _fake_now_in_tz)
    return _FROZEN_NOW


@pytest.mark.usefixtures("frozen_streak_clock")
@pytest.mark.asyncio
async def test_streak_uses_user_timezone_across_utc_midnight(
    db_session: AsyncSession,
) -> None:
    """Same UTC day = two different Pacific days -> different streak counts.

    Recreates the BUG-STREAK-002 scenario.  Two completions both fall on
    UTC date 2026-06-15 (06:00 UTC and 18:00 UTC), so a UTC-bucketed
    streak collapses them onto one day and reports 1.  The 06:00 UTC
    moment is 23:00 PDT on the *previous* day, so a Pacific-bucketed
    streak sees two consecutive days and reports 2.  This is exactly
    the divergence West Coast users experienced in production.
    """
    user = await _make_user(db_session)
    assert user.id is not None
    goal = await _make_goal(db_session, user.id)
    assert goal.id is not None

    # 23:00 PDT on 2026-06-14 = 06:00 UTC on 2026-06-15
    late_pacific_yesterday = datetime(2026, 6, 15, 6, 0, tzinfo=UTC)
    # 11:00 PDT on 2026-06-15 = 18:00 UTC on 2026-06-15
    morning_pacific_today = datetime(2026, 6, 15, 18, 0, tzinfo=UTC)

    db_session.add_all(
        [
            GoalCompletion(
                goal_id=goal.id,
                user_id=user.id,
                completed_units=goal.target,
                timestamp=late_pacific_yesterday,
            ),
            GoalCompletion(
                goal_id=goal.id,
                user_id=user.id,
                completed_units=goal.target,
                timestamp=morning_pacific_today,
            ),
        ]
    )
    await db_session.commit()

    # In UTC both timestamps share calendar day 2026-06-15 -> streak = 1.
    assert await compute_consecutive_streak(db_session, goal.id, user.id, "UTC") == 1
    # In Pacific they fall on consecutive days (06-14 and 06-15) -> streak = 2.
    assert (
        await compute_consecutive_streak(
            db_session,
            goal.id,
            user.id,
            "America/Los_Angeles",
        )
        == 2
    )


@pytest.mark.usefixtures("frozen_streak_clock")
@pytest.mark.asyncio
async def test_streak_buckets_to_different_dates_pago_pago_vs_kiritimati(
    db_session: AsyncSession,
) -> None:
    """The same UTC instant credits different calendar dates per zone.

    Asserts on :func:`domain.dates.to_user_date` directly so the
    behaviour the BUG-STREAK-002 fix relies on (different bucketing per
    user TZ) is pinned by the test, not just the trivial
    ``streak == 1`` count which would pass for any single completion.
    """
    moment = datetime(2026, 6, 15, 0, 30, tzinfo=UTC)
    pago_date = to_user_date("Pacific/Pago_Pago", moment)
    kiritimati_date = to_user_date("Pacific/Kiritimati", moment)
    # Pacific/Pago_Pago is UTC-11; 00:30 UTC = 13:30 prior day local.
    assert pago_date == date(2026, 6, 14)
    # Pacific/Kiritimati is UTC+14; 00:30 UTC = 14:30 same UTC day local.
    assert kiritimati_date == date(2026, 6, 15)
    assert pago_date != kiritimati_date

    # Sanity-check that a single completion still streaks to 1 in both
    # zones (the bucketing diverges, the count does not).
    user = await _make_user(db_session)
    assert user.id is not None
    goal = await _make_goal(db_session, user.id)
    assert goal.id is not None
    db_session.add(
        GoalCompletion(
            goal_id=goal.id,
            user_id=user.id,
            completed_units=goal.target,
            timestamp=moment,
        ),
    )
    await db_session.commit()

    assert await compute_consecutive_streak(db_session, goal.id, user.id, "Pacific/Pago_Pago") == 1
    assert await compute_consecutive_streak(db_session, goal.id, user.id, "Pacific/Kiritimati") == 1


# ── BUG-FE-HABIT-207 backend parity: recency gate on stale chains ──────────


def _utc_dt_n_days_ago(days: int) -> datetime:
    """Return a tz-aware UTC datetime ``days`` ago at noon for fixture clarity."""
    return (datetime.now(UTC) - timedelta(days=days)).replace(
        hour=12,
        minute=0,
        second=0,
        microsecond=0,
    )


def test_compute_habit_streak_returns_zero_when_chain_is_stale() -> None:
    """A 5-day chain that ended 5 days ago must report 0, not 5.

    Mirrors the frontend ``streakFromCompletions`` recency gate.  Without
    this the Habits list would advertise "10-day streak 🔥" while the
    stats overlay (which uses the frontend helper) shows 0 -- a visible
    discrepancy that the gate prevents.
    """
    user_id = 999
    goal_id = 1
    completions = [
        GoalCompletion(
            goal_id=goal_id,
            user_id=user_id,
            completed_units=1.0,
            timestamp=_utc_dt_n_days_ago(days_ago),
        )
        for days_ago in (5, 6, 7, 8, 9)
    ]

    assert compute_habit_streak(completions, "UTC") == 0


def test_compute_habit_streak_counts_chain_ending_yesterday() -> None:
    """A chain that ended yesterday is still active (one-day grace window)."""
    user_id = 999
    goal_id = 1
    completions = [
        GoalCompletion(
            goal_id=goal_id,
            user_id=user_id,
            completed_units=1.0,
            timestamp=_utc_dt_n_days_ago(days_ago),
        )
        for days_ago in (1, 2, 3)
    ]

    assert compute_habit_streak(completions, "UTC") == 3


def test_compute_habit_streak_counts_chain_including_today() -> None:
    """A chain that includes today reports the full length."""
    user_id = 999
    goal_id = 1
    completions = [
        GoalCompletion(
            goal_id=goal_id,
            user_id=user_id,
            completed_units=1.0,
            timestamp=_utc_dt_n_days_ago(days_ago),
        )
        for days_ago in (0, 1, 2)
    ]

    assert compute_habit_streak(completions, "UTC") == 3


@pytest.mark.asyncio
async def test_compute_consecutive_streak_returns_zero_when_chain_is_stale(
    db_session: AsyncSession,
) -> None:
    """DB path matches the in-memory path: a stale chain reports 0."""
    user = await _make_user(db_session)
    assert user.id is not None
    goal = await _make_goal(db_session, user.id)
    assert goal.id is not None

    for days_ago in (5, 6, 7):
        db_session.add(
            GoalCompletion(
                goal_id=goal.id,
                user_id=user.id,
                completed_units=goal.target,
                timestamp=_utc_dt_n_days_ago(days_ago),
            ),
        )
    await db_session.commit()

    assert await compute_consecutive_streak(db_session, goal.id, user.id, "UTC") == 0


# ── Subtractive habits: no-log days count as abstention success ────────────


def test_compute_habit_streak_subtractive_with_no_logs_counts_from_start_date() -> None:
    """A subtractive habit with zero logs accrues a streak day per calendar day.

    User opened the app every day but never had any sugar to log; the
    habit started 5 days ago, so the streak should be 6 (today + the
    five days since start).  This is the exact case the bug report
    pointed at: "It should still mark achieved if it hasn't been logged
    at all, meaning I have abstained."
    """
    today = datetime.now(UTC).date()
    ctx = SubtractiveContext(clear_threshold=5.0, start_date=today - timedelta(days=5))

    assert compute_habit_streak([], "UTC", ctx) == 6


def test_compute_habit_streak_subtractive_breaks_on_transgression() -> None:
    """Logging above the clear threshold yesterday breaks the streak there.

    Today is still success (no log = 0 sugar), but yesterday's
    transgression (7 > clear=5) ends the chain — streak = 1.
    """
    yesterday = _utc_dt_n_days_ago(1)
    completions = [GoalCompletion(goal_id=1, user_id=1, completed_units=7.0, timestamp=yesterday)]
    today_date = datetime.now(UTC).date()
    ctx = SubtractiveContext(clear_threshold=5.0, start_date=today_date - timedelta(days=10))

    assert compute_habit_streak(completions, "UTC", ctx) == 1


def test_compute_habit_streak_subtractive_below_threshold_keeps_streak() -> None:
    """A small log under the clear threshold still counts as a success day."""
    completions = [
        GoalCompletion(
            goal_id=1,
            user_id=1,
            completed_units=2.0,
            timestamp=_utc_dt_n_days_ago(days_ago),
        )
        for days_ago in (0, 1, 2)
    ]
    today_date = datetime.now(UTC).date()
    ctx = SubtractiveContext(clear_threshold=5.0, start_date=today_date - timedelta(days=5))

    # Five days of habit existence, every day below the clear threshold ->
    # full streak from today back to start_date (6 days inclusive).
    assert compute_habit_streak(completions, "UTC", ctx) == 6


def test_compute_habit_streak_subtractive_at_threshold_is_success() -> None:
    """A log *equal* to the clear threshold is "just under" — the day still counts.

    The frontend's tier resolver treats ``total <= target`` as success
    for subtractive goals; the backend streak must agree or the tile's
    "Achieved Today!" badge and the streak counter diverge on the edge
    case.
    """
    today_dt = _utc_dt_n_days_ago(0)
    completions = [GoalCompletion(goal_id=1, user_id=1, completed_units=5.0, timestamp=today_dt)]
    today_date = datetime.now(UTC).date()
    ctx = SubtractiveContext(clear_threshold=5.0, start_date=today_date)

    assert compute_habit_streak(completions, "UTC", ctx) == 1


def test_compute_habit_streak_subtractive_returns_zero_before_start_date() -> None:
    """A habit that hasn't started yet has no streak to accrue."""
    today_date = datetime.now(UTC).date()
    ctx = SubtractiveContext(clear_threshold=5.0, start_date=today_date + timedelta(days=3))
    assert compute_habit_streak([], "UTC", ctx) == 0


@pytest.mark.asyncio
async def test_compute_consecutive_streak_subtractive_no_logs(
    db_session: AsyncSession,
) -> None:
    """DB path: a subtractive goal with no logs streaks from start_date.

    Mirrors :func:`test_compute_habit_streak_subtractive_with_no_logs_counts_from_start_date`
    so the in-memory path used by ``GET /habits`` and the per-goal DB
    path used during check-in report the same number.
    """
    user = await _make_user(db_session)
    assert user.id is not None
    goal = await _make_goal(db_session, user.id)
    assert goal.id is not None

    today_date = datetime.now(UTC).date()
    ctx = SubtractiveContext(clear_threshold=5.0, start_date=today_date - timedelta(days=3))
    assert await compute_consecutive_streak(db_session, goal.id, user.id, "UTC", ctx) == 4


@pytest.mark.asyncio
async def test_compute_consecutive_streak_subtractive_breaks_on_transgression(
    db_session: AsyncSession,
) -> None:
    """DB path: a single above-threshold log day breaks the abstention chain."""
    user = await _make_user(db_session)
    assert user.id is not None
    goal = await _make_goal(db_session, user.id)
    assert goal.id is not None

    db_session.add(
        GoalCompletion(
            goal_id=goal.id,
            user_id=user.id,
            completed_units=10.0,  # well above clear=5
            timestamp=_utc_dt_n_days_ago(2),
        ),
    )
    await db_session.commit()

    today_date = datetime.now(UTC).date()
    ctx = SubtractiveContext(clear_threshold=5.0, start_date=today_date - timedelta(days=10))
    # Today + yesterday are abstention days (streak=2), then day -2 is a
    # transgression that breaks the chain.
    assert await compute_consecutive_streak(db_session, goal.id, user.id, "UTC", ctx) == 2
