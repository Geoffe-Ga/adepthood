"""Tests for GET /habits/{id}/stats endpoint."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.goal import Goal
from models.goal_completion import GoalCompletion

# Named constants for test assertions (avoids magic-number lint warnings)
DAYS_IN_WEEK = 7
EXPECTED_MONDAY_UNITS = 3.0  # 2.0 + 1.0 from two completions
EXPECTED_WEDNESDAY_UNITS = 3.0
EXPECTED_COMPLETIONS_3_ENTRIES = 3
EXPECTED_LONGEST_STREAK_3 = 3
EXPECTED_COMPLETIONS_5_ENTRIES = 5
EXPECTED_CURRENT_STREAK_2 = 2
COMPLETION_RATE_TOLERANCE = 0.01
EXPECTED_ALICE_UNITS = 5.0


def sample_payload(**overrides: object) -> dict[str, object]:
    """Return a valid habit creation payload."""
    payload: dict[str, object] = {
        "name": "Drink Water",
        "icon": "💧",
        "start_date": "2024-01-01",
        "energy_cost": 1,
        "energy_return": 2,
        "stage": "aptitude",
        "notification_times": ["08:00"],
        "notification_frequency": "daily",
        "notification_days": ["mon"],
        "milestone_notifications": True,
        "sort_order": 1,
    }
    payload.update(overrides)
    return payload


async def _signup(client: AsyncClient, username: str = "alice") -> dict[str, str]:
    """Create a user and return auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


async def _signup_with_id(
    client: AsyncClient, username: str = "alice"
) -> tuple[dict[str, str], int]:
    """Create a user and return (auth headers, user_id).

    BUG-T7: ``Habit`` responses no longer expose ``user_id``, so tests that
    seed completions directly via the ORM source the id from ``/auth/signup``
    (which legitimately returns it to the caller about themselves).
    """
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, body["user_id"]


async def _create_habit_with_goal(
    client: AsyncClient,
    session: AsyncSession,
    headers: dict[str, str],
) -> tuple[int, int]:
    """Create a habit and a goal, returning (habit_id, goal_id)."""
    resp = await client.post("/habits/", json=sample_payload(), headers=headers)
    habit_id: int = resp.json()["id"]
    goal = Goal(
        habit_id=habit_id,
        title="Drink 8 glasses",
        tier="clear",
        target=8,
        target_unit="glasses",
        frequency=1,
        frequency_unit="per_day",
        is_additive=True,
    )
    session.add(goal)
    await session.commit()
    await session.refresh(goal)
    assert goal.id is not None
    return habit_id, goal.id


# ── Authentication ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stats_unauthenticated_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.get("/habits/1/stats")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_stats_nonexistent_habit_returns_404(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.get("/habits/9999/stats", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_stats_other_users_habit_returns_403(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """BUG-T7: cross-user stats fetch returns 403, not 404."""
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")
    habit_id, _ = await _create_habit_with_goal(async_client, db_session, alice_headers)
    resp = await async_client.get(f"/habits/{habit_id}/stats", headers=bob_headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


# ── Empty stats ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stats_no_completions(async_client: AsyncClient, db_session: AsyncSession) -> None:
    """A habit with no completions returns zeroed stats."""
    headers = await _signup(async_client)
    habit_id, _ = await _create_habit_with_goal(async_client, db_session, headers)
    resp = await async_client.get(f"/habits/{habit_id}/stats", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["total_completions"] == 0
    assert data["longest_streak"] == 0
    assert data["current_streak"] == 0
    assert data["completion_rate"] == 0.0
    assert data["completion_dates"] == []
    assert len(data["day_labels"]) == DAYS_IN_WEEK
    assert all(v == 0 for v in data["values"])
    assert all(v == 0 for v in data["completions_by_day"])


# ── Stats with completions ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stats_aggregates_completions_by_day_of_week(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Units should be summed per day-of-week across all goals."""
    headers, user_id = await _signup_with_id(async_client)
    habit_id, goal_id = await _create_habit_with_goal(async_client, db_session, headers)

    # Monday 2024-01-01 — two completions
    db_session.add(
        GoalCompletion(
            goal_id=goal_id,
            user_id=user_id,
            timestamp=datetime(2024, 1, 1, 8, 0, tzinfo=UTC),
            completed_units=2.0,
        )
    )
    db_session.add(
        GoalCompletion(
            goal_id=goal_id,
            user_id=user_id,
            timestamp=datetime(2024, 1, 1, 12, 0, tzinfo=UTC),
            completed_units=1.0,
        )
    )
    # Wednesday 2024-01-03
    db_session.add(
        GoalCompletion(
            goal_id=goal_id,
            user_id=user_id,
            timestamp=datetime(2024, 1, 3, 10, 0, tzinfo=UTC),
            completed_units=3.0,
        )
    )
    await db_session.commit()

    resp = await async_client.get(f"/habits/{habit_id}/stats", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["total_completions"] == EXPECTED_COMPLETIONS_3_ENTRIES
    # Monday=index 1, Wednesday=index 3
    assert data["values"][1] == EXPECTED_MONDAY_UNITS  # 2+1
    assert data["values"][3] == EXPECTED_WEDNESDAY_UNITS
    # completions_by_day: 1 if any completion that weekday, else 0
    assert data["completions_by_day"][1] == 1
    assert data["completions_by_day"][2] == 0
    assert data["completions_by_day"][3] == 1


@pytest.mark.asyncio
async def test_stats_longest_streak(async_client: AsyncClient, db_session: AsyncSession) -> None:
    """Longest streak is the max consecutive calendar days with completions."""
    headers, user_id = await _signup_with_id(async_client)
    habit_id, goal_id = await _create_habit_with_goal(async_client, db_session, headers)

    # 3 consecutive days, then a gap, then 2 consecutive
    base = datetime(2024, 1, 1, 8, 0, tzinfo=UTC)
    for day_offset in [0, 1, 2, 4, 5]:
        db_session.add(
            GoalCompletion(
                goal_id=goal_id,
                user_id=user_id,
                timestamp=base + timedelta(days=day_offset),
                completed_units=1.0,
            )
        )
    await db_session.commit()

    resp = await async_client.get(f"/habits/{habit_id}/stats", headers=headers)
    data = resp.json()
    assert data["longest_streak"] == EXPECTED_LONGEST_STREAK_3
    assert data["total_completions"] == EXPECTED_COMPLETIONS_5_ENTRIES


@pytest.mark.asyncio
async def test_stats_current_streak(async_client: AsyncClient, db_session: AsyncSession) -> None:
    """Current streak counts consecutive days ending at the most recent completion.

    Anchored at today/yesterday so the recency gate in
    ``_current_streak`` (which mirrors the frontend
    ``streakFromCompletions`` rule) does not zero the chain because the
    fixture used dates from 2024.
    """
    headers, user_id = await _signup_with_id(async_client)
    habit_id, goal_id = await _create_habit_with_goal(async_client, db_session, headers)

    # Older completion (gap), then yesterday + day-before-yesterday so the
    # recency gate sees a fresh chain ending within the one-day grace
    # window.  Counting backwards: yesterday + 2-days-ago = streak of 2.
    now = datetime.now(UTC).replace(hour=8, minute=0, second=0, microsecond=0)
    for days_ago in (5, 2, 1):
        db_session.add(
            GoalCompletion(
                goal_id=goal_id,
                user_id=user_id,
                timestamp=now - timedelta(days=days_ago),
                completed_units=1.0,
            )
        )
    await db_session.commit()

    resp = await async_client.get(f"/habits/{habit_id}/stats", headers=headers)
    data = resp.json()
    assert data["current_streak"] == EXPECTED_CURRENT_STREAK_2


@pytest.mark.asyncio
async def test_stats_completion_rate(async_client: AsyncClient, db_session: AsyncSession) -> None:
    """Completion rate = days-with-completions / span-days."""
    headers, user_id = await _signup_with_id(async_client)
    habit_id, goal_id = await _create_habit_with_goal(async_client, db_session, headers)

    # Jan 1 and Jan 3 — span is 3 days, completed on 2
    db_session.add(
        GoalCompletion(
            goal_id=goal_id,
            user_id=user_id,
            timestamp=datetime(2024, 1, 1, 8, 0, tzinfo=UTC),
            completed_units=1.0,
        )
    )
    db_session.add(
        GoalCompletion(
            goal_id=goal_id,
            user_id=user_id,
            timestamp=datetime(2024, 1, 3, 8, 0, tzinfo=UTC),
            completed_units=1.0,
        )
    )
    await db_session.commit()

    resp = await async_client.get(f"/habits/{habit_id}/stats", headers=headers)
    data = resp.json()
    assert abs(data["completion_rate"] - 2 / 3) < COMPLETION_RATE_TOLERANCE


@pytest.mark.asyncio
async def test_stats_completion_dates(async_client: AsyncClient, db_session: AsyncSession) -> None:
    """completion_dates lists unique ISO date strings for calendar marking."""
    headers, user_id = await _signup_with_id(async_client)
    habit_id, goal_id = await _create_habit_with_goal(async_client, db_session, headers)

    # Two completions on same day + one on another day
    db_session.add(
        GoalCompletion(
            goal_id=goal_id,
            user_id=user_id,
            timestamp=datetime(2024, 1, 1, 8, 0, tzinfo=UTC),
            completed_units=2.0,
        )
    )
    db_session.add(
        GoalCompletion(
            goal_id=goal_id,
            user_id=user_id,
            timestamp=datetime(2024, 1, 1, 12, 0, tzinfo=UTC),
            completed_units=1.0,
        )
    )
    db_session.add(
        GoalCompletion(
            goal_id=goal_id,
            user_id=user_id,
            timestamp=datetime(2024, 1, 3, 10, 0, tzinfo=UTC),
            completed_units=3.0,
        )
    )
    await db_session.commit()

    resp = await async_client.get(f"/habits/{habit_id}/stats", headers=headers)
    data = resp.json()
    dates = sorted(data["completion_dates"])
    assert dates == ["2024-01-01", "2024-01-03"]


@pytest.mark.asyncio
async def test_stats_only_counts_current_users_completions(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Stats should not include completions from other users."""
    alice_headers, alice_user_id = await _signup_with_id(async_client, "alice")
    _, bob_user_id = await _signup_with_id(async_client, "bob")

    # Alice creates a habit+goal
    habit_id, goal_id = await _create_habit_with_goal(async_client, db_session, alice_headers)

    # Alice's completion
    db_session.add(
        GoalCompletion(
            goal_id=goal_id,
            user_id=alice_user_id,
            timestamp=datetime(2024, 1, 1, 8, 0, tzinfo=UTC),
            completed_units=5.0,
        )
    )
    # Bob's completion on Alice's goal (should not count)
    db_session.add(
        GoalCompletion(
            goal_id=goal_id,
            user_id=bob_user_id,
            timestamp=datetime(2024, 1, 2, 8, 0, tzinfo=UTC),
            completed_units=10.0,
        )
    )
    await db_session.commit()

    resp = await async_client.get(f"/habits/{habit_id}/stats", headers=alice_headers)
    data = resp.json()
    assert data["total_completions"] == 1
    assert sum(data["values"]) == EXPECTED_ALICE_UNITS


@pytest.mark.asyncio
async def test_stats_current_streak_returns_zero_for_stale_chain(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """``_current_streak`` mirrors the services.streaks recency gate.

    Without this, ``GET /habits/{id}/stats`` would advertise a multi-day
    streak whose chain ended a week ago while ``GET /habits``
    (``compute_habit_streak``) correctly returned 0 -- exactly the API
    contract divergence the recency gate was introduced to eliminate.
    """
    headers, user_id = await _signup_with_id(async_client)
    habit_id, goal_id = await _create_habit_with_goal(async_client, db_session, headers)

    # Three consecutive days that ended five days ago -- chain is well
    # outside the one-day grace window, so the gate must fire.
    now = datetime.now(UTC).replace(hour=8, minute=0, second=0, microsecond=0)
    for days_ago in (5, 6, 7):
        db_session.add(
            GoalCompletion(
                goal_id=goal_id,
                user_id=user_id,
                timestamp=now - timedelta(days=days_ago),
                completed_units=1.0,
            ),
        )
    await db_session.commit()

    resp = await async_client.get(f"/habits/{habit_id}/stats", headers=headers)
    data = resp.json()
    assert data["current_streak"] == 0
    # Longest streak is unaffected by the recency gate -- it still
    # reflects the historical 3-day run.
    assert data["longest_streak"] == 3
