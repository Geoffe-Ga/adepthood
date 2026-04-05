"""Tests for the GoalGroup CRUD API."""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.goal import Goal

SEED_TEMPLATE_COUNT = 3
GOAL_TIER_COUNT = 3


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


# ---------------------------------------------------------------------------
# List
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_goal_groups_includes_shared_templates(
    async_client: AsyncClient,
) -> None:
    """Listing goal groups returns shared templates even with no user groups."""
    headers = await _signup(async_client)
    resp = await async_client.get("/goal-groups/", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert len(data) >= SEED_TEMPLATE_COUNT
    template_names = {g["name"] for g in data if g["shared_template"]}
    assert "Meditation Goals" in template_names
    assert "Exercise Goals" in template_names
    assert "Nutrition Goals" in template_names


@pytest.mark.asyncio
async def test_list_goal_groups_includes_user_groups(
    async_client: AsyncClient,
) -> None:
    """User-created groups appear in the listing alongside templates."""
    headers = await _signup(async_client)

    await async_client.post(
        "/goal-groups/",
        json={"name": "My Custom Group", "icon": "🎯"},
        headers=headers,
    )

    resp = await async_client.get("/goal-groups/", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    names = {g["name"] for g in resp.json()}
    assert "My Custom Group" in names


@pytest.mark.asyncio
async def test_list_goal_groups_excludes_other_users(
    async_client: AsyncClient,
) -> None:
    """A user should not see another user's private goal groups."""
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")

    await async_client.post(
        "/goal-groups/",
        json={"name": "Alice Private"},
        headers=alice_headers,
    )

    resp = await async_client.get("/goal-groups/", headers=bob_headers)
    names = {g["name"] for g in resp.json()}
    assert "Alice Private" not in names


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_goal_group(async_client: AsyncClient) -> None:
    """Creating a goal group returns 201 with the new group."""
    headers = await _signup(async_client)

    resp = await async_client.post(
        "/goal-groups/",
        json={
            "name": "Strength Training",
            "icon": "💪",
            "description": "Progressive strength targets",
        },
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.CREATED
    data = resp.json()
    assert data["name"] == "Strength Training"
    assert data["icon"] == "💪"
    assert data["description"] == "Progressive strength targets"
    assert data["shared_template"] is False
    assert data["user_id"] is not None
    assert data["goals"] == []


@pytest.mark.asyncio
async def test_create_shared_template(async_client: AsyncClient) -> None:
    """Creating a shared template sets user_id to null."""
    headers = await _signup(async_client)

    resp = await async_client.post(
        "/goal-groups/",
        json={
            "name": "Community Template",
            "shared_template": True,
            "source": "community",
        },
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.CREATED
    data = resp.json()
    assert data["shared_template"] is True
    assert data["user_id"] is None
    assert data["source"] == "community"


# ---------------------------------------------------------------------------
# Get single
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_goal_group(async_client: AsyncClient) -> None:
    """Fetching a single group returns it with goals."""
    headers = await _signup(async_client)

    create_resp = await async_client.post(
        "/goal-groups/",
        json={"name": "Test Group"},
        headers=headers,
    )
    group_id = create_resp.json()["id"]

    resp = await async_client.get(f"/goal-groups/{group_id}", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["name"] == "Test Group"


@pytest.mark.asyncio
async def test_get_goal_group_not_found(async_client: AsyncClient) -> None:
    """Fetching a nonexistent group returns 404."""
    headers = await _signup(async_client)

    resp = await async_client.get("/goal-groups/9999", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_get_other_users_group_returns_404(
    async_client: AsyncClient,
) -> None:
    """A user cannot fetch another user's private group."""
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")

    create_resp = await async_client.post(
        "/goal-groups/",
        json={"name": "Alice Only"},
        headers=alice_headers,
    )
    group_id = create_resp.json()["id"]

    resp = await async_client.get(f"/goal-groups/{group_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_get_shared_template_accessible_by_any_user(
    async_client: AsyncClient,
) -> None:
    """Shared templates are accessible by any authenticated user."""
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")

    # Alice creates a shared template
    create_resp = await async_client.post(
        "/goal-groups/",
        json={"name": "Shared Yoga", "shared_template": True},
        headers=alice_headers,
    )
    group_id = create_resp.json()["id"]

    # Bob can access it
    resp = await async_client.get(f"/goal-groups/{group_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["name"] == "Shared Yoga"


# ---------------------------------------------------------------------------
# Update
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_update_goal_group(async_client: AsyncClient) -> None:
    """Updating a goal group changes its fields."""
    headers = await _signup(async_client)

    create_resp = await async_client.post(
        "/goal-groups/",
        json={"name": "Old Name", "icon": "🔴"},
        headers=headers,
    )
    group_id = create_resp.json()["id"]

    resp = await async_client.put(
        f"/goal-groups/{group_id}",
        json={"name": "New Name", "icon": "🟢"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["name"] == "New Name"
    assert resp.json()["icon"] == "🟢"


@pytest.mark.asyncio
async def test_update_other_users_group_returns_404(
    async_client: AsyncClient,
) -> None:
    """A user cannot update another user's group."""
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")

    create_resp = await async_client.post(
        "/goal-groups/",
        json={"name": "Alice Group"},
        headers=alice_headers,
    )
    group_id = create_resp.json()["id"]

    resp = await async_client.put(
        f"/goal-groups/{group_id}",
        json={"name": "Hijacked"},
        headers=bob_headers,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_goal_group(async_client: AsyncClient) -> None:
    """Deleting a group returns 204 and removes it."""
    headers = await _signup(async_client)

    create_resp = await async_client.post(
        "/goal-groups/",
        json={"name": "To Delete"},
        headers=headers,
    )
    group_id = create_resp.json()["id"]

    resp = await async_client.delete(f"/goal-groups/{group_id}", headers=headers)
    assert resp.status_code == HTTPStatus.NO_CONTENT

    get_resp = await async_client.get(f"/goal-groups/{group_id}", headers=headers)
    assert get_resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_delete_unlinks_goals_but_keeps_them(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Deleting a group sets goal_group_id to null on linked goals."""
    headers = await _signup(async_client)

    # Create a habit first
    habit_resp = await async_client.post(
        "/habits/",
        json={
            "name": "Meditate",
            "icon": "🧘",
            "start_date": "2024-01-01",
            "energy_cost": 3,
            "energy_return": 5,
        },
        headers=headers,
    )
    habit_id = habit_resp.json()["id"]

    # Create a goal group
    group_resp = await async_client.post(
        "/goal-groups/",
        json={"name": "Med Goals"},
        headers=headers,
    )
    group_id = group_resp.json()["id"]

    # Create a goal linked to the group directly in DB
    goal = Goal(
        habit_id=habit_id,
        title="10 min meditation",
        tier="clear",
        target=10,
        target_unit="minutes",
        frequency=1,
        frequency_unit="per_day",
        goal_group_id=group_id,
    )
    db_session.add(goal)
    await db_session.commit()
    await db_session.refresh(goal)
    goal_id = goal.id

    # Delete the group
    resp = await async_client.delete(f"/goal-groups/{group_id}", headers=headers)
    assert resp.status_code == HTTPStatus.NO_CONTENT

    # Goal should still exist but with goal_group_id = None
    await db_session.refresh(goal)
    updated_goal = await db_session.get(Goal, goal_id)
    assert updated_goal is not None
    assert updated_goal.goal_group_id is None


@pytest.mark.asyncio
async def test_delete_other_users_group_returns_404(
    async_client: AsyncClient,
) -> None:
    """A user cannot delete another user's group."""
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")

    create_resp = await async_client.post(
        "/goal-groups/",
        json={"name": "Alice Protected"},
        headers=alice_headers,
    )
    group_id = create_resp.json()["id"]

    resp = await async_client.delete(f"/goal-groups/{group_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


# ---------------------------------------------------------------------------
# Goal group with goals (response nesting)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_goal_group_response_includes_goals(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """GoalGroupResponse includes nested goals."""
    headers = await _signup(async_client)

    habit_resp = await async_client.post(
        "/habits/",
        json={
            "name": "Exercise",
            "icon": "🏃",
            "start_date": "2024-01-01",
            "energy_cost": 5,
            "energy_return": 7,
        },
        headers=headers,
    )
    habit_id = habit_resp.json()["id"]

    group_resp = await async_client.post(
        "/goal-groups/",
        json={"name": "Exercise Goals", "icon": "🏋️"},
        headers=headers,
    )
    group_id = group_resp.json()["id"]

    # Add goals linked to the group
    for tier, target in [("low", 15), ("clear", 30), ("stretch", 60)]:
        goal = Goal(
            habit_id=habit_id,
            title=f"{target} min exercise",
            tier=tier,
            target=target,
            target_unit="minutes",
            frequency=1,
            frequency_unit="per_day",
            goal_group_id=group_id,
        )
        db_session.add(goal)
    await db_session.commit()

    resp = await async_client.get(f"/goal-groups/{group_id}", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert len(data["goals"]) == GOAL_TIER_COUNT
    tiers = {g["tier"] for g in data["goals"]}
    assert tiers == {"low", "clear", "stretch"}


# ---------------------------------------------------------------------------
# Seed templates are idempotent
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_seed_templates_are_idempotent(
    async_client: AsyncClient,
) -> None:
    """Calling list twice does not duplicate seed templates."""
    headers = await _signup(async_client)

    resp1 = await async_client.get("/goal-groups/", headers=headers)
    count1 = len([g for g in resp1.json() if g["shared_template"]])

    resp2 = await async_client.get("/goal-groups/", headers=headers)
    count2 = len([g for g in resp2.json() if g["shared_template"]])

    assert count1 == count2
