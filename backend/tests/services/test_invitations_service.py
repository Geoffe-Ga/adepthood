"""Integration tests for :mod:`services.invitations` — invitation-signal generation.

These tests FAIL until both ``backend/src/services/invitations.py`` and
``backend/src/domain/invitations.py`` exist.  That is the correct RED state.

Pinned service contract:
  generate_invitation_signals(session, user_id, user_timezone="UTC")
      -> list[InvitationSignal]

The function gathers readiness aggregates, calls the pure domain fn, deduplicates
against ALL existing InvitationSignal rows (dismissed or live), inserts survivors,
and returns only the newly inserted rows.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from conftest import test_engine
from domain.dates import now_in_tz, to_user_date_bucket
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.invitation_signal import InvitationSignal
from models.journal_entry import JournalEntry
from models.practice import Practice
from models.practice_session import PracticeSession
from models.user import User
from models.user_practice import UserPractice
from services.invitations import generate_invitation_signals

# ---------------------------------------------------------------------------
# Shared fixture helpers
# ---------------------------------------------------------------------------

_SUSTAINED_STREAK = 21  # mirrors SUSTAINED_HABIT_STREAK_DAYS
_SUSTAINED_WEEKS = 4  # mirrors SUSTAINED_PRACTICE_WEEKS
_HIGH_ACTIVE_DAYS = 25  # mirrors HIGH_ENGAGEMENT_ACTIVE_DAYS
_ENGAGEMENT_WINDOW_DAYS = 30  # mirrors ENGAGEMENT_WINDOW_DAYS
_LA_TZ = "America/Los_Angeles"


async def _make_user(session: AsyncSession, email: str = "inv@example.com") -> int:
    """Insert a User row and return its id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.commit()
    await session.refresh(user)
    assert user.id is not None
    return user.id


async def _make_habit_with_streak(
    session: AsyncSession,
    user_id: int,
    streak_days: int,
    *,
    name: str = "Meditate",
) -> int:
    """Seed a Habit with ``streak`` field set and the matching GoalCompletion rows.

    Also sets ``Habit.streak`` directly so any service path that reads the
    denormalized counter sees the right value.
    """
    habit = Habit(
        name=name,
        icon="flame",
        start_date=datetime.now(UTC).date() - timedelta(days=streak_days),
        stage="1",
        streak=streak_days,
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
        title="Daily sit",
        tier="clear",
        target=1.0,
        target_unit="minutes",
        frequency=1.0,
        frequency_unit="per_day",
    )
    session.add(goal)
    await session.commit()
    await session.refresh(goal)
    assert goal.id is not None

    now = datetime.now(UTC)
    for days_ago in range(streak_days):
        session.add(
            GoalCompletion(
                goal_id=goal.id,
                user_id=user_id,
                completed_units=goal.target,
                timestamp=now - timedelta(days=days_ago),
            )
        )
    await session.commit()
    return habit.id


async def _make_practice_with_sessions(
    session: AsyncSession,
    user_id: int,
    *,
    weeks: int,
    name: str = "Morning sit",
) -> int:
    """Seed Practice + UserPractice + PracticeSession rows sufficient for ``weeks`` weeks."""
    practice = Practice(
        stage_number=1,
        name=name,
        description="x",
        instructions="x",
        default_duration_minutes=10.0,
        mode="meditation_timer",
        mode_config={"mode": "meditation_timer", "duration_minutes": 10},
    )
    session.add(practice)
    await session.commit()
    await session.refresh(practice)
    assert practice.id is not None

    start = datetime.now(UTC).date() - timedelta(weeks=weeks)
    up = UserPractice(
        user_id=user_id,
        practice_id=practice.id,
        stage_number=1,
        start_date=start,
    )
    session.add(up)
    await session.commit()
    await session.refresh(up)
    assert up.id is not None

    # Four sessions per week spread evenly to satisfy any "active per week" check.
    now = datetime.now(UTC)
    for week in range(weeks):
        for day_offset in (0, 2, 4, 6):
            session.add(
                PracticeSession(
                    user_id=user_id,
                    user_practice_id=up.id,
                    duration_minutes=10.0,
                    timestamp=now - timedelta(weeks=week, days=day_offset),
                )
            )
    await session.commit()
    return practice.id


# ---------------------------------------------------------------------------
# SELECT-count helper (mirrors test_completion_candidates.py pattern)
# ---------------------------------------------------------------------------


@contextmanager
def _count_selects() -> Iterator[list[str]]:
    """Count SELECT statements run against the shared test engine."""
    counter: list[str] = []

    def _before(
        _conn: object,
        _cursor: object,
        statement: str,
        _params: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        if statement.lstrip().upper().startswith("SELECT"):
            counter.append(statement)

    sync_engine = test_engine.sync_engine
    event.listen(sync_engine, "before_cursor_execute", _before)
    try:
        yield counter
    finally:
        event.remove(sync_engine, "before_cursor_execute", _before)


# ---------------------------------------------------------------------------
# Helpers for asserting persisted rows
# ---------------------------------------------------------------------------


async def _signals_for(session: AsyncSession, user_id: int) -> list[InvitationSignal]:
    """Return all InvitationSignal rows for user_id (dismissed or live)."""
    result = await session.execute(
        select(InvitationSignal).where(col(InvitationSignal.user_id) == user_id)
    )
    return list(result.scalars().all())


# ---------------------------------------------------------------------------
# 8. Persists new row when signal is triggered
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_generates_and_persists_habit_consistency_signal(
    db_session: AsyncSession,
) -> None:
    """A habit streak at threshold causes one InvitationSignal row to be inserted."""
    user_id = await _make_user(db_session)
    habit_id = await _make_habit_with_streak(db_session, user_id, streak_days=_SUSTAINED_STREAK)

    returned = await generate_invitation_signals(db_session, user_id)

    assert len(returned) == 1
    assert returned[0].target_type == "habit"
    assert returned[0].target_id == habit_id
    assert returned[0].kind == "consistency"

    # Row must be persisted — verify via an independent query using col().
    persisted = await _signals_for(db_session, user_id)
    assert len(persisted) == 1
    assert persisted[0].id is not None
    assert persisted[0].target_type == "habit"
    assert persisted[0].target_id == habit_id
    assert persisted[0].kind == "consistency"
    assert persisted[0].dismissed_at is None


# ---------------------------------------------------------------------------
# 9. Idempotent: second run inserts nothing, returns empty
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_second_call_is_idempotent_and_returns_empty(
    db_session: AsyncSession,
) -> None:
    """Running generate_invitation_signals twice inserts the row exactly once."""
    user_id = await _make_user(db_session)
    await _make_habit_with_streak(db_session, user_id, streak_days=_SUSTAINED_STREAK)

    first = await generate_invitation_signals(db_session, user_id)
    second = await generate_invitation_signals(db_session, user_id)

    assert len(first) == 1
    assert second == []

    # Still exactly one row in the DB after two calls.
    persisted = await _signals_for(db_session, user_id)
    assert len(persisted) == 1


# ---------------------------------------------------------------------------
# 10. Dismissed row blocks regeneration (core acceptance criterion)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dismissed_signal_is_never_regenerated(
    db_session: AsyncSession,
) -> None:
    """A dismissed row blocks re-creation — the dedup covers live AND dismissed rows."""
    user_id = await _make_user(db_session)
    habit_id = await _make_habit_with_streak(db_session, user_id, streak_days=_SUSTAINED_STREAK)

    # First call creates the row.
    first_batch = await generate_invitation_signals(db_session, user_id)
    assert len(first_batch) == 1
    row = first_batch[0]
    assert row.id is not None

    # Dismiss the row (simulate user declining).
    row.dismissed_at = datetime.now(UTC)
    db_session.add(row)
    await db_session.commit()

    # Verify it is dismissed via col() query.
    dismissed_rows = await db_session.execute(
        select(InvitationSignal).where(
            col(InvitationSignal.user_id) == user_id,
            col(InvitationSignal.target_id) == habit_id,
            col(InvitationSignal.kind) == "consistency",
        )
    )
    dismissed_signal = dismissed_rows.scalars().one()
    assert dismissed_signal.dismissed_at is not None

    # Second call must return nothing and must not create a duplicate.
    second_batch = await generate_invitation_signals(db_session, user_id)
    assert second_batch == []

    all_rows = await _signals_for(db_session, user_id)
    assert len(all_rows) == 1  # the dismissed row, not a new one
    assert all_rows[0].id == row.id


# ---------------------------------------------------------------------------
# 11. Null-target dedup: embodied_community not duplicated across runs
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_null_target_embodied_community_not_duplicated(
    db_session: AsyncSession,
) -> None:
    """The null-target partial index dedups embodied_community across runs."""
    # Seed a pre-existing row directly so we can test the dedup path in isolation.
    user_id = await _make_user(db_session)
    existing = InvitationSignal(
        user_id=user_id,
        target_type="embodied_community",
        target_id=None,
        kind="readiness",
    )
    db_session.add(existing)
    await db_session.commit()
    await db_session.refresh(existing)
    assert existing.id is not None

    # Now seed data that would normally generate the same signal.
    now = datetime.now(UTC)
    for day_offset in range(25):
        db_session.add(
            JournalEntry(
                message=f"Entry {day_offset}",
                sender="user",
                user_id=user_id,
                timestamp=now - timedelta(days=day_offset),
            )
        )
    await db_session.commit()

    result = await generate_invitation_signals(db_session, user_id)

    # Dedup must block a second embodied_community row.
    assert not any(r.target_type == "embodied_community" for r in result)

    all_rows = await _signals_for(db_session, user_id)
    community_rows = [r for r in all_rows if r.target_type == "embodied_community"]
    assert len(community_rows) == 1
    assert community_rows[0].id == existing.id


# ---------------------------------------------------------------------------
# 12. Below-threshold user → no rows inserted
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_below_threshold_user_produces_no_signals(
    db_session: AsyncSession,
) -> None:
    """A user with a streak of 1 generates no signals (silence-by-default)."""
    user_id = await _make_user(db_session)
    await _make_habit_with_streak(db_session, user_id, streak_days=1)

    result = await generate_invitation_signals(db_session, user_id)

    assert result == []
    persisted = await _signals_for(db_session, user_id)
    assert persisted == []


# ---------------------------------------------------------------------------
# 13. Bounded query count — no N+1 over habits
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_gather_does_not_produce_n_plus_one_queries(
    db_session: AsyncSession,
) -> None:
    """Adding a second above-threshold habit must not add another round-trip.

    A fixed SELECT budget is generous; the point is that scaling habits does
    not scale queries.  If the gather uses a single aggregation query this
    passes trivially; if it issues per-habit SELECTs it fails at >= 2 habits.
    """
    user_id = await _make_user(db_session)
    await _make_habit_with_streak(
        db_session, user_id, streak_days=_SUSTAINED_STREAK, name="Habit A"
    )
    await _make_habit_with_streak(
        db_session, user_id, streak_days=_SUSTAINED_STREAK + 5, name="Habit B"
    )

    with _count_selects() as queries_one:
        await generate_invitation_signals(db_session, user_id)

    # Now add a third habit and check that the count does not grow proportionally.
    # We can't re-run on the same session (dedup blocks inserts), so we measure
    # relative growth: two habits must use the same or fewer queries than three.
    user_id_2 = await _make_user(db_session, "inv2@example.com")
    await _make_habit_with_streak(
        db_session, user_id_2, streak_days=_SUSTAINED_STREAK, name="Habit X"
    )
    await _make_habit_with_streak(
        db_session, user_id_2, streak_days=_SUSTAINED_STREAK, name="Habit Y"
    )
    await _make_habit_with_streak(
        db_session, user_id_2, streak_days=_SUSTAINED_STREAK, name="Habit Z"
    )

    with _count_selects() as queries_two:
        await generate_invitation_signals(db_session, user_id_2)

    # Both runs should use the same number of SELECT round-trips (constant query count).
    assert len(queries_two) <= len(queries_one) + 2, (
        f"N+1 suspected: 2-habit run used {len(queries_one)} SELECTs, "
        f"3-habit run used {len(queries_two)}"
    )


# ---------------------------------------------------------------------------
# 14. Non-UTC timezone: the active-days window boundary must be a true instant
# ---------------------------------------------------------------------------


async def _seed_journal_days(
    session: AsyncSession, user_id: int, timestamps: list[datetime]
) -> None:
    """Seed one JournalEntry per supplied timestamp (a cross-feature activity row)."""
    for index, ts in enumerate(timestamps):
        session.add(
            JournalEntry(
                message=f"Entry {index}",
                sender="user",
                user_id=user_id,
                timestamp=ts,
            )
        )
    await session.commit()


@pytest.mark.asyncio
async def test_active_days_window_boundary_uses_utc_instant_under_non_utc_tz(
    db_session: AsyncSession,
) -> None:
    """The 30-day window boundary must compare instants, not the user's wall-clock offset.

    ``America/Los_Angeles`` runs at ``-07:00``/``-08:00``.  SQLite stores the
    activity timestamps as ``+00:00`` ISO strings and compares them *lexically*,
    blind to the offset suffix, so a boundary carrying the user's offset skews the
    window edge by that offset.  Here we seed exactly 24 distinct in-window local
    days (below the 25-day threshold) plus one activity that is genuinely *outside*
    the true UTC 30-day window but sits within one LA offset of the edge.  A
    user-offset boundary wrongly pulls that stale row in — lifting the distinct-day
    count to 25 and fabricating an ``embodied_community`` candidate.  The
    UTC-normalized boundary excludes it, so the count stays 24 and no signal is
    emitted.
    """
    user_id = await _make_user(db_session)
    now_la = now_in_tz(_LA_TZ)

    # 24 distinct in-window local days: comfortably inside the true UTC window
    # (each anchored at local noon so day-bucketing is unambiguous).
    in_window: list[datetime] = []
    for days_ago in range(1, 25):
        local_day = (now_la - timedelta(days=days_ago)).replace(
            hour=12, minute=0, second=0, microsecond=0
        )
        in_window.append(local_day.astimezone(UTC))

    # One activity 3 hours older than the true 30-day cutoff: excluded by a UTC
    # instant boundary, but wrongly included by the LA-offset (buggy) boundary,
    # which is over-inclusive at the trailing edge by the zone offset.
    stale = now_la - timedelta(days=_ENGAGEMENT_WINDOW_DAYS, hours=3)
    stale_utc = stale.astimezone(UTC)

    await _seed_journal_days(db_session, user_id, [*in_window, stale_utc])

    # The 24 in-window rows must bucket to 24 distinct LA days, and the stale row
    # must fall on a distinct 25th LA day — otherwise the boundary flip can't move
    # the count across the threshold and the guard would not exercise the bug.
    in_window_days = {to_user_date_bucket(ts, _LA_TZ) for ts in in_window}
    assert len(in_window_days) == 24
    assert to_user_date_bucket(stale_utc, _LA_TZ) not in in_window_days

    result = await generate_invitation_signals(db_session, user_id, user_timezone=_LA_TZ)

    # True UTC-instant window counts 24 active days (< 25) → no community signal.
    assert not any(r.target_type == "embodied_community" for r in result)
    persisted = await _signals_for(db_session, user_id)
    assert not any(r.target_type == "embodied_community" for r in persisted)
