"""Unit tests for :mod:`services.streaks` — DB-aware streak + milestone helpers."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from domain.dates import to_user_date
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.user import User
from schemas.milestone import Milestone
from services.streaks import check_milestones, compute_consecutive_streak, update_streak


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
    user = User(email="streaks@example.com")
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
    from services.streaks import compute_habit_streak  # noqa: PLC0415 -- co-located with usage

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
    from services.streaks import compute_habit_streak  # noqa: PLC0415 -- co-located with usage

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
    from services.streaks import compute_habit_streak  # noqa: PLC0415 -- co-located with usage

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
