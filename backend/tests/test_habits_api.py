"""Tests for the habits CRUD API — DB-backed with authentication."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from domain.dates import today_in_tz
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit


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


def sample_goal_payload(**overrides: object) -> dict[str, object]:
    """Return a valid goal creation payload."""
    payload: dict[str, object] = {
        "title": "Drink 8 glasses",
        "tier": "clear",
        "target": 8,
        "target_unit": "glasses",
        "frequency": 1,
        "frequency_unit": "per_day",
        "is_additive": True,
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


# ── Unauthenticated access ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unauthenticated_create_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.post("/habits/", json=sample_payload())
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_unauthenticated_list_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.get("/habits/")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ── CRUD ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_habit(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post("/habits/", json=sample_payload(), headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["name"] == "Drink Water"
    assert data["notification_times"] == ["08:00"]
    assert data["id"] is not None


@pytest.mark.asyncio
async def test_list_habits_sorted(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await async_client.post(
        "/habits/", json=sample_payload(name="Two", sort_order=2), headers=headers
    )
    await async_client.post(
        "/habits/", json=sample_payload(name="One", sort_order=1), headers=headers
    )
    resp = await async_client.get("/habits/", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    names = [h["name"] for h in resp.json()]
    assert names == ["One", "Two"]


@pytest.mark.asyncio
async def test_get_habit(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    create_resp = await async_client.post("/habits/", json=sample_payload(), headers=headers)
    habit_id = create_resp.json()["id"]
    resp = await async_client.get(f"/habits/{habit_id}", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["name"] == "Drink Water"


@pytest.mark.asyncio
async def test_create_habit_seeds_three_default_goals(async_client: AsyncClient) -> None:
    """``POST /habits/`` returns the new habit with low/clear/stretch defaults.

    Without this, ``POST /goal_completions/`` always 404'd because the
    server never had goals to look up -- there was no goal-creation
    endpoint at all and the frontend's local goals never made the wire.
    Pinning the contract here so a future refactor that drops the
    auto-seed (or changes the tier set) fails the suite instead of
    silently breaking habit logging end-to-end.
    """
    headers = await _signup(async_client)
    resp = await async_client.post("/habits/", json=sample_payload(), headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    tiers = sorted(g["tier"] for g in body["goals"])
    assert tiers == ["clear", "low", "stretch"]
    # Each default goal carries a real autoincrement id so the frontend
    # can immediately ``PUT /goals/{id}`` against any of them.
    assert all(isinstance(g["id"], int) and g["id"] > 0 for g in body["goals"])


@pytest.mark.asyncio
async def test_update_habit(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    create_resp = await async_client.post("/habits/", json=sample_payload(), headers=headers)
    habit_id = create_resp.json()["id"]
    resp = await async_client.put(
        f"/habits/{habit_id}", json=sample_payload(name="Updated"), headers=headers
    )
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["name"] == "Updated"


@pytest.mark.asyncio
async def test_delete_habit_returns_204(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    create_resp = await async_client.post("/habits/", json=sample_payload(), headers=headers)
    habit_id = create_resp.json()["id"]
    resp = await async_client.delete(f"/habits/{habit_id}", headers=headers)
    assert resp.status_code == HTTPStatus.NO_CONTENT
    # Confirm gone
    get_resp = await async_client.get(f"/habits/{habit_id}", headers=headers)
    assert get_resp.status_code == HTTPStatus.NOT_FOUND


# ── User isolation ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_user_cannot_see_other_users_habits(async_client: AsyncClient) -> None:
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")
    await async_client.post(
        "/habits/", json=sample_payload(name="Alice Habit"), headers=alice_headers
    )
    resp = await async_client.get("/habits/", headers=bob_headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == []


@pytest.mark.asyncio
async def test_user_cannot_get_other_users_habit(async_client: AsyncClient) -> None:
    """BUG-T7: cross-user GET returns 403 (was 404).  See ``tests/security/test_idor.py``."""
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")
    create_resp = await async_client.post("/habits/", json=sample_payload(), headers=alice_headers)
    habit_id = create_resp.json()["id"]
    resp = await async_client.get(f"/habits/{habit_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_user_cannot_delete_other_users_habit(async_client: AsyncClient) -> None:
    """BUG-T7: cross-user DELETE returns 403 (was 404)."""
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")
    create_resp = await async_client.post("/habits/", json=sample_payload(), headers=alice_headers)
    habit_id = create_resp.json()["id"]
    resp = await async_client.delete(f"/habits/{habit_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_get_nonexistent_habit_returns_404(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.get("/habits/9999", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


# ── Type alignment (phase-1-11) ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_habit_with_stage(async_client: AsyncClient) -> None:
    """Habits accept and return a 'stage' field."""
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/habits/", json=sample_payload(stage="aptitude"), headers=headers
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["stage"] == "aptitude"


@pytest.mark.asyncio
async def test_create_habit_defaults_streak_to_zero(async_client: AsyncClient) -> None:
    """New habits should have streak=0 in the response."""
    headers = await _signup(async_client)
    resp = await async_client.post("/habits/", json=sample_payload(), headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["streak"] == 0


@pytest.mark.asyncio
async def test_get_habit_includes_goals(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """GET /habits/{id} returns nested goals list (defaults + any added)."""
    headers = await _signup(async_client)
    create_resp = await async_client.post("/habits/", json=sample_payload(), headers=headers)
    habit_id = create_resp.json()["id"]

    # Insert an extra goal beyond the three defaults seeded by ``POST /habits/``.
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
    db_session.add(goal)
    await db_session.commit()

    resp = await async_client.get(f"/habits/{habit_id}", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert "goals" in data
    titles = [g["title"] for g in data["goals"]]
    assert "Drink 8 glasses" in titles


@pytest.mark.asyncio
async def test_list_habits_includes_goals(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """GET /habits/ returns nested goals in each habit (defaults + any added)."""
    headers = await _signup(async_client)
    create_resp = await async_client.post("/habits/", json=sample_payload(), headers=headers)
    habit_id = create_resp.json()["id"]

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
    db_session.add(goal)
    await db_session.commit()

    resp = await async_client.get("/habits/", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    habits_list = resp.json()
    assert len(habits_list) == 1
    titles = [g["title"] for g in habits_list[0]["goals"]]
    assert "Drink 8 glasses" in titles


@pytest.mark.asyncio
async def test_get_habit_includes_goal_completions(async_client: AsyncClient) -> None:
    """``GET /habits/{id}`` embeds each goal's logged completions (BUG-FE-HABIT-301)."""
    headers = await _signup(async_client)
    create_resp = await async_client.post("/habits/", json=sample_payload(), headers=headers)
    habit_id = create_resp.json()["id"]
    goal_id = next(g["id"] for g in create_resp.json()["goals"] if g["tier"] == "clear")

    log_resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal_id, "did_complete": True},
        headers=headers,
    )
    assert log_resp.status_code == HTTPStatus.OK

    resp = await async_client.get(f"/habits/{habit_id}", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    clear_goal = next(g for g in body["goals"] if g["tier"] == "clear")
    completions = clear_goal["completions"]
    assert len(completions) == 1
    [completion] = completions
    # Pin the surviving row's identity: seeded clear goal has target=2.0.
    assert completion["completed_units"] == 2.0
    assert isinstance(completion["timestamp"], str)
    assert isinstance(completion["id"], int)


@pytest.mark.asyncio
async def test_list_habits_includes_goal_completions(async_client: AsyncClient) -> None:
    """``GET /habits/`` (collection) embeds completions on every nested goal."""
    headers = await _signup(async_client)
    create_resp = await async_client.post("/habits/", json=sample_payload(), headers=headers)
    goal_id = next(g["id"] for g in create_resp.json()["goals"] if g["tier"] == "clear")

    log_resp = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal_id, "did_complete": True},
        headers=headers,
    )
    assert log_resp.status_code == HTTPStatus.OK

    resp = await async_client.get("/habits/", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    [habit] = resp.json()
    clear_goal = next(g for g in habit["goals"] if g["tier"] == "clear")
    assert len(clear_goal["completions"]) == 1


# Three subtractive tiers (low/clear/stretch) matching the onboarding
# shape; lifted to module scope so the helper below stays at 3 args and
# under the project's PLR0913 limit.
_SUBTRACTIVE_TIERS_FOR_API: tuple[tuple[str, float], ...] = (
    ("low", 10.0),
    ("clear", 5.0),
    ("stretch", 2.0),
)


async def _signup_with_user_id(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Variant of ``_signup`` that also returns the user id for DB-direct seeding."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, data["user_id"]


@pytest.mark.asyncio
async def test_get_habits_reports_subtractive_streak_from_start_date(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``GET /habits`` runs the subtractive streak path end-to-end.

    The check-in path (``POST /goal_completions``) and the list path
    (``GET /habits``) build the ``SubtractiveContext`` through two
    separate helpers -- ``_subtractive_context_for_goal`` queries the
    DB directly, while ``_populate_streak`` reads the eager-loaded
    ``habit.goals`` relationship.  Per the PR #379 review, only the
    former was HTTP-covered; this test closes the loop on the second
    wiring so a regression in ``_subtractive_context`` (e.g. dropping
    the tier filter, returning ``None`` for a valid habit) flips a red
    test instead of silently zeroing the streak on the user's tile.
    """
    headers, user_id = await _signup_with_user_id(async_client, "abstain_list")
    today = today_in_tz("UTC")
    start = today - timedelta(days=3)
    habit = Habit(
        name="No sugar",
        icon="🍬",
        start_date=start,
        energy_cost=1,
        energy_return=2,
        user_id=user_id,
    )
    db_session.add(habit)
    await db_session.commit()
    await db_session.refresh(habit)
    for tier, target in _SUBTRACTIVE_TIERS_FOR_API:
        db_session.add(
            Goal(
                habit_id=habit.id,
                title=f"{tier} sugar",
                tier=tier,
                target=target,
                target_unit="g",
                frequency=1.0,
                frequency_unit="per_day",
                is_additive=False,
            )
        )
    await db_session.commit()

    resp = await async_client.get("/habits/", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    [body_habit] = resp.json()
    # 4 days = today + the three prior abstention days since start_date.
    # If ``_subtractive_context`` regressed to the additive path the
    # streak would be 0 (no log rows at all -> additive recency gate
    # zeroes the chain), so this assertion specifically pins polarity.
    assert body_habit["streak"] == 4


@pytest.mark.asyncio
async def test_get_habit_completions_filtered_to_caller(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Per-row ``user_id`` filter excludes cross-tenant completions from the embed."""
    alice_headers = await _signup(async_client, "alice_persist")
    create_resp = await async_client.post("/habits/", json=sample_payload(), headers=alice_headers)
    habit_id = create_resp.json()["id"]
    goal_id = next(g["id"] for g in create_resp.json()["goals"] if g["tier"] == "clear")

    # Alice logs her own completion via the API.
    own_log = await async_client.post(
        "/goal_completions/",
        json={"goal_id": goal_id, "did_complete": True},
        headers=alice_headers,
    )
    assert own_log.status_code == HTTPStatus.OK

    # Foreign sentinel (Alice's seeded clear goal writes 2.0); 42.0 is unmistakable.
    stray_units = 42.0
    stray = GoalCompletion(goal_id=goal_id, user_id=999_999, completed_units=stray_units)
    db_session.add(stray)
    await db_session.commit()

    resp = await async_client.get(f"/habits/{habit_id}", headers=alice_headers)
    assert resp.status_code == HTTPStatus.OK
    clear_goal = next(g for g in resp.json()["goals"] if g["tier"] == "clear")
    assert len(clear_goal["completions"]) == 1
    surviving = clear_goal["completions"][0]
    # Equality on Alice's seeded clear-goal target; pins the row's identity, not absence-of-stray.
    assert surviving["completed_units"] == 2.0
    assert surviving["completed_units"] != stray_units


@pytest.mark.asyncio
async def test_invalid_notification_frequency_rejected(async_client: AsyncClient) -> None:
    """notification_frequency must be one of daily/weekly/custom/off or null."""
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/habits/",
        json=sample_payload(notification_frequency="every_two_hours"),
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_duplicate_habit_name_rejected(async_client: AsyncClient) -> None:
    """A second habit with the same name (case-insensitive) is rejected with 409."""
    headers = await _signup(async_client)
    first = await async_client.post("/habits/", json=sample_payload(name="Run"), headers=headers)
    assert first.status_code == HTTPStatus.OK

    duplicate = await async_client.post(
        "/habits/", json=sample_payload(name=" run  "), headers=headers
    )
    assert duplicate.status_code == HTTPStatus.CONFLICT
    assert duplicate.json()["detail"] == "duplicate_habit_name"


@pytest.mark.asyncio
async def test_habit_quota_caps_per_user(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The per-user habit count cap returns 409 once exceeded."""
    # Lower the cap so we don't have to seed 100 rows.
    monkeypatch.setattr("routers.habits._MAX_HABITS_PER_USER", 2)
    headers = await _signup(async_client, "quota_user")
    for i in range(2):
        resp = await async_client.post(
            "/habits/", json=sample_payload(name=f"Habit {i}"), headers=headers
        )
        assert resp.status_code == HTTPStatus.OK
    resp = await async_client.post(
        "/habits/", json=sample_payload(name="Overflow"), headers=headers
    )
    assert resp.status_code == HTTPStatus.CONFLICT
    assert resp.json()["detail"] == "habit_quota_exceeded"


@pytest.mark.asyncio
async def test_delete_habit_logs_cascade_counts(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """``delete_habit`` emits a structured cascade-count audit row."""
    headers = await _signup(async_client, "cascade_user")
    create = await async_client.post("/habits/", json=sample_payload(), headers=headers)
    habit_id = create.json()["id"]

    # Seed a goal so the cascade has something to count.
    goal = Goal(
        habit_id=habit_id,
        title="g",
        tier="clear",
        target=1,
        target_unit="glasses",
        frequency=1,
        frequency_unit="per_day",
        is_additive=True,
    )
    db_session.add(goal)
    await db_session.commit()

    with caplog.at_level(logging.INFO, logger="routers.habits"):
        resp = await async_client.delete(f"/habits/{habit_id}", headers=headers)
    assert resp.status_code == HTTPStatus.NO_CONTENT
    cascade_logs = [r for r in caplog.records if r.message == "habit_deleted"]
    assert cascade_logs, "expected a habit_deleted audit log entry"
    # Three default goals (auto-seeded by POST /habits/) + one manually added.
    assert getattr(cascade_logs[0], "cascade_goals", None) == 4


@pytest.mark.asyncio
async def test_cross_tenant_delete_emits_audit_log(
    async_client: AsyncClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A cross-tenant delete probe emits a ``resource_access_denied`` audit row."""
    alice_headers = await _signup(async_client, "alice_owner")
    bob_headers = await _signup(async_client, "bob_probe")

    create = await async_client.post("/habits/", json=sample_payload(), headers=alice_headers)
    habit_id = create.json()["id"]

    with caplog.at_level(logging.WARNING, logger="dependencies.ownership"):
        resp = await async_client.delete(f"/habits/{habit_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN
    deny_logs = [r for r in caplog.records if r.message == "resource_access_denied"]
    assert deny_logs, "expected a resource_access_denied audit log entry"
    assert getattr(deny_logs[0], "resource", None) == "habit"
    assert getattr(deny_logs[0], "resource_id", None) == habit_id


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_concurrent_create_with_same_name_yields_one_row(
    concurrent_async_client: AsyncClient,
) -> None:
    """Concurrent ``POST /habits`` with the same name persist exactly one row.

    Closes the duplicate-name TOCTOU: the application pre-check used to
    be the only guard, so two requests could both pass it before either
    inserted.  The unique index on ``(user_id, lower(trim(name)))`` plus
    the ``IntegrityError → 409 duplicate_habit_name`` fallback keep the
    row count at one and the loser gets the same envelope as a sequential
    duplicate.
    """
    signup_resp = await concurrent_async_client.post(
        "/auth/signup",
        json={
            "email": "racehabit@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    headers = {"Authorization": f"Bearer {signup_resp.json()['token']}"}
    payload = sample_payload(name="Race Habit")

    fanout = 5
    responses = await asyncio.gather(
        *[
            concurrent_async_client.post("/habits/", json=payload, headers=headers)
            for _ in range(fanout)
        ]
    )

    statuses = [r.status_code for r in responses]
    assert statuses.count(HTTPStatus.OK) == 1, statuses
    assert statuses.count(HTTPStatus.CONFLICT) == fanout - 1, statuses
    duplicate_details = {
        r.json().get("detail") for r in responses if r.status_code == HTTPStatus.CONFLICT
    }
    assert duplicate_details == {"duplicate_habit_name"}

    listing = await concurrent_async_client.get("/habits/", headers=headers)
    items = listing.json()
    assert len(items) == 1
    assert items[0]["name"] == "Race Habit"


@pytest.mark.asyncio
async def test_update_habit_rename_collision_returns_409(async_client: AsyncClient) -> None:
    """Renaming a habit to one already owned by the same user surfaces 409, not 500."""
    headers = await _signup(async_client, "rename_user")

    first = await async_client.post("/habits/", json=sample_payload(name="Run"), headers=headers)
    second = await async_client.post("/habits/", json=sample_payload(name="Walk"), headers=headers)
    second_id = second.json()["id"]

    # Try to rename "Walk" -> "Run", which collides with the first habit.
    rename = await async_client.put(
        f"/habits/{second_id}",
        json=sample_payload(name="run"),  # case-insensitive collision
        headers=headers,
    )
    assert rename.status_code == HTTPStatus.CONFLICT
    assert rename.json()["detail"] == "duplicate_habit_name"

    # Renaming to a non-colliding name still works.
    ok = await async_client.put(
        f"/habits/{second_id}", json=sample_payload(name="Stroll"), headers=headers
    )
    assert ok.status_code == HTTPStatus.OK
    assert ok.json()["name"] == "Stroll"

    # Untouched first habit still exists.
    assert first.status_code == HTTPStatus.OK


@pytest.mark.asyncio
async def test_habit_endpoints_window_embedded_completions(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Issue #294: the habit GETs embed only the rolling-window completions.

    A retention-period account otherwise ships its entire completion
    history on every cold load.  Rows older than the 90-day window stay
    in the database (and still feed the stats endpoint) but are trimmed
    from the ``GET /habits/`` and ``GET /habits/{id}`` transport.
    """
    headers = await _signup(async_client, "windowed")
    create_resp = await async_client.post("/habits/", json=sample_payload(), headers=headers)
    habit_id = create_resp.json()["id"]
    goal_id = next(g["id"] for g in create_resp.json()["goals"] if g["tier"] == "clear")
    habit_row = await db_session.get(Habit, habit_id)
    assert habit_row is not None

    now_naive = datetime.now(UTC).replace(tzinfo=None)
    for days_back, units in ((120, 5.0), (5, 2.0)):
        db_session.add(
            GoalCompletion(
                goal_id=goal_id,
                user_id=habit_row.user_id,
                completed_units=units,
                timestamp=now_naive - timedelta(days=days_back),
            )
        )
    await db_session.commit()

    detail = await async_client.get(f"/habits/{habit_id}", headers=headers)
    detail_goal = next(g for g in detail.json()["goals"] if g["id"] == goal_id)
    assert [c["completed_units"] for c in detail_goal["completions"]] == [2.0]

    collection = await async_client.get("/habits/", headers=headers)
    coll_goal = next(g for h in collection.json() for g in h["goals"] if g["id"] == goal_id)
    assert [c["completed_units"] for c in coll_goal["completions"]] == [2.0]

    # The stats endpoint deliberately keeps the FULL history — windowing
    # it would silently change all-time aggregates.
    stats = await async_client.get(f"/habits/{habit_id}/stats", headers=headers)
    assert stats.status_code == HTTPStatus.OK
    assert stats.json()["total_completions"] == 2
