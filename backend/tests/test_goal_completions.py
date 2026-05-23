"""Tests for the goal completions API — DB-backed with authentication."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, date, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import select

from domain.dates import today_in_tz
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from services.streaks import compute_consecutive_streak


async def _signup(client: AsyncClient, username: str = "goaluser") -> tuple[dict[str, str], int]:
    """Create a user and return (auth headers, user_id)."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, data["user_id"]


async def _seed_goal(
    db_session: AsyncSession,
    user_id: int,
    *,
    habit_name: str = "Meditation",
) -> Goal:
    """Create a habit + goal in the DB and return the goal."""
    habit = Habit(
        name=habit_name,
        icon="🧘",
        start_date=date(2025, 1, 1),
        energy_cost=10,
        energy_return=20,
        user_id=user_id,
    )
    db_session.add(habit)
    await db_session.commit()
    await db_session.refresh(habit)

    goal = Goal(
        habit_id=habit.id,
        title="Daily sit",
        tier="clear",
        target=10.0,
        target_unit="minutes",
        frequency=1.0,
        frequency_unit="per_day",
        is_additive=True,
    )
    db_session.add(goal)
    await db_session.commit()
    await db_session.refresh(goal)
    return goal


# ── Unauthenticated access ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_completion_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": 1, "did_complete": True},
    )
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ── Completion increments streak ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_completion_increments_streak_and_returns_milestone(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client)
    goal = await _seed_goal(db_session, user_id)

    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["streak"] == 1
    assert data["reason_code"] == "streak_incremented"
    # ``Milestone`` schema expanded (BUG-SCHEMA-002): assert on the
    # threshold + the default ``kind`` rather than dict-equality so a
    # future field addition (e.g. ``label``) does not break this test.
    assert len(data["milestones"]) == 1
    milestone = data["milestones"][0]
    assert milestone["threshold"] == 1
    assert milestone["kind"] == "streak_milestone"


@pytest.mark.asyncio
async def test_same_day_completion_is_idempotent(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Second completion on the same day returns already_logged_today (BUG-HABITS-015)."""
    headers, user_id = await _signup(async_client)
    goal = await _seed_goal(db_session, user_id)

    # First completion
    resp1 = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )
    assert resp1.json()["streak"] == 1

    # Same-day retry
    resp2 = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )
    assert resp2.status_code == HTTPStatus.OK
    data = resp2.json()
    assert data["streak"] == 1
    assert data["reason_code"] == "already_logged_today"
    assert data["milestones"] == []


@pytest.mark.asyncio
async def test_consecutive_day_completions_build_streak(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Completions on consecutive days build the streak."""
    headers, user_id = await _signup(async_client)
    goal = await _seed_goal(db_session, user_id)

    # Seed a completion for yesterday directly in the DB
    db_session.add(
        GoalCompletion(
            goal_id=goal.id,
            user_id=user_id,
            completed_units=goal.target,
            timestamp=datetime.now(UTC) - timedelta(days=1),
        )
    )
    await db_session.commit()

    # Today's completion via API
    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    expected_streak = 2
    assert data["streak"] == expected_streak


# ── Miss resets streak ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_miss_on_unscheduled_day_holds_streak(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A miss on a non-scheduled day holds the streak rather than zeroing it."""
    headers, user_id = await _signup(async_client, "cadence_user")

    # Pick a weekday that is NOT today (in the user's timezone -- defaults
    # to UTC in tests so this matches the route handler's
    # ``today_in_tz(user_tz)`` resolution exactly).
    today_name = today_in_tz("UTC").strftime("%a")
    other_days = [
        day for day in ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun") if day != today_name
    ]

    habit = Habit(
        name="Cadence",
        icon="📅",
        start_date=date(2025, 1, 1),
        energy_cost=1,
        energy_return=1,
        user_id=user_id,
        notification_days=other_days,
    )
    db_session.add(habit)
    await db_session.commit()
    await db_session.refresh(habit)

    goal = Goal(
        habit_id=habit.id,
        title="Daily sit",
        tier="clear",
        target=10.0,
        target_unit="minutes",
        frequency=1.0,
        frequency_unit="per_day",
        is_additive=True,
    )
    db_session.add(goal)
    await db_session.commit()
    await db_session.refresh(goal)

    # Seed yesterday's completion so the streak is 1 going in.
    db_session.add(
        GoalCompletion(
            goal_id=goal.id,
            user_id=user_id,
            completed_units=goal.target,
            timestamp=datetime.now(UTC) - timedelta(days=1),
        )
    )
    await db_session.commit()

    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": False},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["reason_code"] == "streak_held"
    assert data["streak"] == 1


@pytest.mark.asyncio
async def test_miss_resets_streak(async_client: AsyncClient, db_session: AsyncSession) -> None:
    headers, user_id = await _signup(async_client)
    goal = await _seed_goal(db_session, user_id)

    # Seed a completion yesterday
    db_session.add(
        GoalCompletion(
            goal_id=goal.id,
            user_id=user_id,
            completed_units=goal.target,
            timestamp=datetime.now(UTC) - timedelta(days=1),
        )
    )
    await db_session.commit()

    # Log a miss today
    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": False},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["streak"] == 0
    assert data["reason_code"] == "streak_reset"
    assert data["milestones"] == []


# ── Unknown goal returns 404 ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unknown_goal_returns_404(async_client: AsyncClient) -> None:
    headers, _user_id = await _signup(async_client)
    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": 999, "did_complete": True},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


# ── User isolation ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_other_users_goal_returns_403(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    _alice_headers, alice_id = await _signup(async_client, "alice")
    bob_headers, _bob_id = await _signup(async_client, "bob")

    goal = await _seed_goal(db_session, alice_id)

    # Bob tries to complete Alice's goal
    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=bob_headers,
    )
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_cross_tenant_goal_completion_emits_audit_log(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A cross-tenant goal-completion probe emits a ``resource_access_denied`` row."""
    _alice_headers, alice_id = await _signup(async_client, "alice_audit")
    bob_headers, _bob_id = await _signup(async_client, "bob_audit")
    goal = await _seed_goal(db_session, alice_id)

    with caplog.at_level(logging.WARNING, logger="dependencies.ownership"):
        resp = await async_client.post(
            "/goal_completions/",
            json={"goal_id": goal.id, "did_complete": True},
            headers=bob_headers,
        )
    assert resp.status_code == HTTPStatus.FORBIDDEN
    deny_logs = [r for r in caplog.records if r.message == "resource_access_denied"]
    assert deny_logs, "expected a resource_access_denied audit log entry"
    assert getattr(deny_logs[0], "resource", None) == "goal"
    assert getattr(deny_logs[0], "resource_id", None) == goal.id


# ── Completion is persisted ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_completion_is_persisted_in_db(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client)
    goal = await _seed_goal(db_session, user_id)

    await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )

    result = await db_session.execute(
        select(GoalCompletion).where(GoalCompletion.goal_id == goal.id)
    )
    completions = list(result.scalars().all())
    assert len(completions) == 1
    assert completions[0].user_id == user_id


# ── Concurrency: BUG-GOAL-001 / BUG-DB-008 ─────────────────────────────


_CONCURRENT_COMPLETION_FANOUT = 5


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_concurrent_completions_yield_one_db_row(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Five simultaneous check-ins for the same goal/day persist exactly one row.

    Closes BUG-GOAL-001: the application-level pre-check
    (``_already_logged_today``) was the only guard against duplicate
    daily completions, and two concurrent requests could both pass it
    before either committed.  The unique-per-day index on
    ``goalcompletion`` plus the ``IntegrityError → already_logged_today``
    fallback keeps the row count at one.  Every loser gets the
    idempotent response shape so retries don't have to special-case
    409s.
    """
    signup_resp = await concurrent_async_client.post(
        "/auth/signup",
        json={
            "email": "racegoal@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    headers = {"Authorization": f"Bearer {signup_resp.json()['token']}"}
    user_id = signup_resp.json()["user_id"]

    async with concurrent_session_factory() as session:
        habit = Habit(
            name="Concurrency drill",
            icon="🏁",
            start_date=date(2025, 1, 1),
            energy_cost=1,
            energy_return=1,
            user_id=user_id,
        )
        session.add(habit)
        await session.commit()
        await session.refresh(habit)
        goal = Goal(
            habit_id=habit.id,
            title="Race",
            tier="clear",
            target=1.0,
            target_unit="reps",
            frequency=1.0,
            frequency_unit="per_day",
            is_additive=True,
        )
        session.add(goal)
        await session.commit()
        await session.refresh(goal)
        goal_id = goal.id

    responses = await asyncio.gather(
        *[
            concurrent_async_client.post(
                "/goal_completions/",
                json={"goal_id": goal_id, "did_complete": True},
                headers=headers,
            )
            for _ in range(_CONCURRENT_COMPLETION_FANOUT)
        ]
    )

    # Every response is OK with the idempotent shape; the unique index
    # collapses the race so the body is uniform regardless of who won.
    assert all(r.status_code == HTTPStatus.OK for r in responses)
    streaks = {r.json()["streak"] for r in responses}
    assert streaks == {1}, streaks
    reason_codes = {r.json()["reason_code"] for r in responses}
    assert reason_codes <= {"streak_incremented", "already_logged_today"}
    # At least one loser hit the IntegrityError / pre-check duplicate path,
    # otherwise the test is not actually exercising the race.
    assert "already_logged_today" in reason_codes

    async with concurrent_session_factory() as session:
        result = await session.execute(
            select(GoalCompletion).where(GoalCompletion.goal_id == goal_id)
        )
        rows = list(result.scalars().all())
    assert len(rows) == 1, [(r.id, r.timestamp) for r in rows]


@pytest.mark.asyncio
async def test_completion_request_rejects_unknown_fields(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``extra="forbid"`` rejects unrecognised payload fields."""
    headers, user_id = await _signup(async_client, "extra_forbid")
    goal = await _seed_goal(db_session, user_id)

    resp = await async_client.post(
        "/goal_completions/",
        json={
            "goal_id": goal.id,
            "did_complete": True,
            "completed_at": "2024-01-01T00:00:00Z",  # client-supplied, not in schema
        },
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


# ── Backfilling a missed past day ───────────────────────────────────────


@pytest.mark.asyncio
async def test_backfill_past_date_records_completion(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``completed_on`` logs a check-in against a past calendar day."""
    headers, user_id = await _signup(async_client, "backfiller")
    goal = await _seed_goal(db_session, user_id)
    yesterday = today_in_tz("UTC") - timedelta(days=1)

    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "completed_on": yesterday.isoformat()},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["reason_code"] == "streak_incremented"

    result = await db_session.execute(
        select(GoalCompletion).where(GoalCompletion.goal_id == goal.id)
    )
    completions = list(result.scalars().all())
    assert len(completions) == 1
    assert completions[0].timestamp.date() == yesterday


@pytest.mark.asyncio
async def test_backfill_future_date_is_rejected(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A ``completed_on`` after today is a 400 -- you cannot log the future."""
    headers, user_id = await _signup(async_client, "future_backfiller")
    goal = await _seed_goal(db_session, user_id)
    tomorrow = today_in_tz("UTC") + timedelta(days=1)

    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "completed_on": tomorrow.isoformat()},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST
    assert resp.json()["detail"] == "completion_date_in_future"


@pytest.mark.asyncio
async def test_backfill_beyond_lookback_window_is_rejected(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A ``completed_on`` older than the 30-day window is a 400.

    Caps how far a streak can be manufactured by backfilling past days.
    """
    headers, user_id = await _signup(async_client, "ancient_backfiller")
    goal = await _seed_goal(db_session, user_id)
    too_old = today_in_tz("UTC") - timedelta(days=31)

    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "completed_on": too_old.isoformat()},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST
    assert resp.json()["detail"] == "completion_date_too_old"


@pytest.mark.asyncio
async def test_backfill_same_past_day_is_idempotent(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Backfilling the same past day twice does not insert a second row."""
    headers, user_id = await _signup(async_client, "idempotent_backfiller")
    goal = await _seed_goal(db_session, user_id)
    yesterday = today_in_tz("UTC") - timedelta(days=1)
    payload = {"goal_id": goal.id, "completed_on": yesterday.isoformat()}

    first = await async_client.post("/goal_completions/", json=payload, headers=headers)
    assert first.status_code == HTTPStatus.OK

    second = await async_client.post("/goal_completions/", json=payload, headers=headers)
    assert second.status_code == HTTPStatus.OK
    assert second.json()["reason_code"] == "already_logged_today"

    result = await db_session.execute(
        select(GoalCompletion).where(GoalCompletion.goal_id == goal.id)
    )
    assert len(list(result.scalars().all())) == 1


@pytest.mark.asyncio
async def test_backfill_past_day_coexists_with_today(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A backfilled past day and a same-session today log are distinct rows."""
    headers, user_id = await _signup(async_client, "coexist_backfiller")
    goal = await _seed_goal(db_session, user_id)
    yesterday = today_in_tz("UTC") - timedelta(days=1)

    backfill = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "completed_on": yesterday.isoformat()},
        headers=headers,
    )
    assert backfill.status_code == HTTPStatus.OK

    today_log = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )
    assert today_log.status_code == HTTPStatus.OK
    # Yesterday + today is a two-day streak.
    expected_streak = 2
    assert today_log.json()["streak"] == expected_streak

    result = await db_session.execute(
        select(GoalCompletion).where(GoalCompletion.goal_id == goal.id)
    )
    assert len(list(result.scalars().all())) == 2


@pytest.mark.asyncio
async def test_response_streak_matches_db_after_commit(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The response ``streak`` is the post-commit DB value, not arithmetic."""
    headers, user_id = await _signup(async_client, "streak_truth")
    goal = await _seed_goal(db_session, user_id)

    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    api_streak = resp.json()["streak"]

    # The API and the DB-level helper share a source of truth.
    assert goal.id is not None
    db_streak = await compute_consecutive_streak(db_session, goal.id, user_id, "UTC")
    assert api_streak == db_streak


# ── Subtractive habits: no-log days count as abstention success ──────────


# Three tiers matching the onboarding shape: low/clear/stretch with
# decreasing target values (subtractive = "stay under the target").
_SUBTRACTIVE_TIERS: tuple[tuple[str, float], ...] = (
    ("low", 10.0),
    ("clear", 5.0),
    ("stretch", 2.0),
)


async def _seed_subtractive_habit(
    db_session: AsyncSession,
    user_id: int,
    start_date: date,
) -> tuple[Goal, Goal, Goal]:
    """Create an abstain-style habit with the three-tier subtractive goal set.

    Returns ``(low, clear, stretch)``.  Mirrors the shape onboarding builds
    so the router's clear-tier lookup is exercised end-to-end — without
    this fixture the new ``_subtractive_context_for_goal`` DB query was
    never executed in any test, exactly the gap the PR review flagged.
    """
    habit = Habit(
        name="No sugar",
        icon="🍬",
        start_date=start_date,
        energy_cost=1,
        energy_return=2,
        user_id=user_id,
    )
    db_session.add(habit)
    await db_session.commit()
    await db_session.refresh(habit)
    goals: list[Goal] = []
    for tier, target in _SUBTRACTIVE_TIERS:
        goal = Goal(
            habit_id=habit.id,
            title=f"{tier} sugar",
            tier=tier,
            target=target,
            target_unit="g",
            frequency=1.0,
            frequency_unit="per_day",
            is_additive=False,
        )
        db_session.add(goal)
        goals.append(goal)
    await db_session.commit()
    for goal in goals:
        await db_session.refresh(goal)
    return goals[0], goals[1], goals[2]


@pytest.mark.asyncio
async def test_subtractive_check_in_uses_clear_tier_threshold(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """End-to-end: ``POST /goal_completions`` resolves the clear-tier sibling.

    The router's ``_subtractive_context_for_goal`` issues a live
    ``session.scalar(select(Goal.target).where(habit_id == ..., tier ==
    'clear'))`` query.  Unit tests on the streak helpers pass a hand-built
    context, so the wiring layer — the SELECT, the tier-string match,
    the SubtractiveContext build — is only covered through this test.

    Posts the check-in against the *stretch* tier (target=2, under
    clear=5) so today's stored row stays in the abstention range and the
    test cleanly demonstrates the subtractive walk: zero prior logs +
    habit started 3 days ago = 4 days of abstention (today + 3 prior).

    If the router silently fell back to additive logic the streak would
    be 1 (today only), so the assertion specifically pins the polarity.
    """
    headers, user_id = await _signup(async_client, "abstain_user")
    today = today_in_tz("UTC")
    _low, _clear, stretch = await _seed_subtractive_habit(
        db_session, user_id, today - timedelta(days=3)
    )
    assert stretch.id is not None

    resp = await async_client.post(
        "/goal_completions/",
        # Logging at the stretch tier stores `target=2` units, below
        # clear=5 -> today counts as a successful abstention day.
        json={"goal_id": stretch.id, "did_complete": True},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    # 4 days = today + the three prior abstention days since start_date.
    expected_streak = 4
    assert resp.json()["streak"] == expected_streak


@pytest.mark.asyncio
async def test_subtractive_check_in_falls_back_to_additive_for_additive_habit(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Additive habits do not pick up the subtractive walk by accident.

    Inverse of :func:`test_subtractive_check_in_uses_clear_tier_threshold`:
    same scenario (habit started 3 days ago, zero prior logs, one log
    today) on a vanilla additive habit must yield streak=1, proving the
    polarity branch in ``_subtractive_context_for_goal`` actually
    distinguishes additive from subtractive.
    """
    headers, user_id = await _signup(async_client, "additive_baseline")
    goal = await _seed_goal(db_session, user_id)
    assert goal.id is not None

    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal.id, "did_complete": True},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["streak"] == 1


@pytest.mark.asyncio
async def test_subtractive_check_in_breaks_streak_on_transgression(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A pre-existing transgression day caps the abstention chain end-to-end."""
    headers, user_id = await _signup(async_client, "abstain_user_transgress")
    today = today_in_tz("UTC")
    _low, clear, _stretch = await _seed_subtractive_habit(
        db_session, user_id, today - timedelta(days=10)
    )
    assert clear.id is not None

    # Two days ago the user blew past the clear=5 limit; the chain should
    # only count today + yesterday.
    db_session.add(
        GoalCompletion(
            goal_id=clear.id,
            user_id=user_id,
            completed_units=20.0,
            timestamp=datetime.now(UTC) - timedelta(days=2),
        )
    )
    await db_session.commit()

    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": clear.id, "did_complete": True},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    expected_streak = 2
    assert resp.json()["streak"] == expected_streak


@pytest.mark.asyncio
async def test_subtractive_check_in_idempotent_path_preserves_subtractive_streak(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Replays of the same-day log keep the subtractive abstention count.

    Covers the ``_idempotent_already_logged_response`` branch — without
    threading ``SubtractiveContext`` through both the happy-path and
    idempotent-replay paths, a retry would fall back to additive logic
    and return a smaller streak than the first call.
    """
    headers, user_id = await _signup(async_client, "abstain_idempotent")
    today = today_in_tz("UTC")
    _low, clear, _stretch = await _seed_subtractive_habit(
        db_session, user_id, today - timedelta(days=4)
    )
    assert clear.id is not None

    first = await async_client.post(
        "/goal_completions/",
        json={"goal_id": clear.id, "did_complete": True},
        headers=headers,
    )
    assert first.status_code == HTTPStatus.OK
    expected_streak = 5  # today + 4 days back since start_date.
    assert first.json()["streak"] == expected_streak

    # Same-day retry hits the already-logged-today branch; the streak
    # must agree with the original response, not the additive fallback.
    second = await async_client.post(
        "/goal_completions/",
        json={"goal_id": clear.id, "did_complete": True},
        headers=headers,
    )
    assert second.status_code == HTTPStatus.OK
    assert second.json()["reason_code"] == "already_logged_today"
    assert second.json()["streak"] == expected_streak


@pytest.mark.asyncio
async def test_subtractive_check_in_fails_loudly_on_duplicate_clear_tier(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A habit with two ``clear``-tier goals returns a stable 500.

    There is no DB-level ``UniqueConstraint`` on ``(habit_id, tier)``
    (PR #379 review).  If a migration artifact or a future multi-group
    schema change ever puts two ``clear`` goals under one habit,
    ``_subtractive_context_for_goal`` MUST refuse to silently pick one
    -- which is exactly what the original ``scalar()`` did.  The router
    catches ``MultipleResultsFound`` and re-raises a 500 with detail
    ``duplicate_clear_tier_goals`` so clients see a predictable code
    instead of an opaque server error.
    """
    headers, user_id = await _signup(async_client, "abstain_dup_clear")
    today = today_in_tz("UTC")
    _low, clear, _stretch = await _seed_subtractive_habit(
        db_session, user_id, today - timedelta(days=3)
    )
    assert clear.id is not None

    # Inject a second ``clear``-tier goal on the same habit.  Schema
    # allows this today; the new guard is what catches it.
    db_session.add(
        Goal(
            habit_id=clear.habit_id,
            title="Duplicate clear sugar",
            tier="clear",
            target=999.0,  # absurd target so a silent pick would skew streak hugely
            target_unit="g",
            frequency=1.0,
            frequency_unit="per_day",
            is_additive=False,
        )
    )
    await db_session.commit()

    resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": clear.id, "did_complete": True},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.INTERNAL_SERVER_ERROR
    assert resp.json()["detail"] == "duplicate_clear_tier_goals"
