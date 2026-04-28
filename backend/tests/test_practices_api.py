"""Tests for the practices API — listing, fetching, and user submission."""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.practice import Practice

_APPROVED_STAGE_1_COUNT = 2


async def _signup(
    client: AsyncClient, username: str = "practitioner"
) -> tuple[dict[str, str], int]:
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


async def _seed_practices(db_session: AsyncSession) -> list[Practice]:
    """Insert a set of approved and unapproved practices."""
    practices = [
        Practice(
            stage_number=1,
            name="Meditation",
            description="Sit quietly",
            instructions="Close your eyes and breathe",
            default_duration_minutes=10,
            approved=True,
        ),
        Practice(
            stage_number=1,
            name="Journaling",
            description="Write reflections",
            instructions="Write for 10 minutes",
            default_duration_minutes=10,
            approved=True,
        ),
        Practice(
            stage_number=2,
            name="Yoga",
            description="Move mindfully",
            instructions="Follow a yoga sequence",
            default_duration_minutes=20,
            approved=True,
        ),
        Practice(
            stage_number=1,
            name="Pending Practice",
            description="Awaiting approval",
            instructions="TBD",
            default_duration_minutes=5,
            submitted_by_user_id=1,
            approved=False,
        ),
    ]
    for p in practices:
        db_session.add(p)
    await db_session.commit()
    for p in practices:
        await db_session.refresh(p)
    return practices


# -- Auth required ----------------------------------------------------------


@pytest.mark.asyncio
async def test_list_practices_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/practices/", params={"stage_number": 1})
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_get_practice_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.get("/practices/1")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# -- List practices ---------------------------------------------------------


@pytest.mark.asyncio
async def test_list_practices_by_stage(async_client: AsyncClient, db_session: AsyncSession) -> None:
    headers, _ = await _signup(async_client)
    await _seed_practices(db_session)

    resp = await async_client.get("/practices/", params={"stage_number": 1}, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    # Should return only approved stage-1 practices (Meditation, Journaling)
    assert len(data) == _APPROVED_STAGE_1_COUNT
    names = {p["name"] for p in data}
    assert names == {"Meditation", "Journaling"}


@pytest.mark.asyncio
async def test_list_practices_excludes_unapproved(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, _ = await _signup(async_client)
    await _seed_practices(db_session)

    resp = await async_client.get("/practices/", params={"stage_number": 1}, headers=headers)
    names = {p["name"] for p in resp.json()}
    assert "Pending Practice" not in names


@pytest.mark.asyncio
async def test_list_practices_empty_stage(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, _ = await _signup(async_client)
    await _seed_practices(db_session)

    resp = await async_client.get("/practices/", params={"stage_number": 99}, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == []


# -- Get single practice ----------------------------------------------------


@pytest.mark.asyncio
async def test_get_practice(async_client: AsyncClient, db_session: AsyncSession) -> None:
    headers, _ = await _signup(async_client)
    practices = await _seed_practices(db_session)
    target = practices[0]

    resp = await async_client.get(f"/practices/{target.id}", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["name"] == "Meditation"
    assert data["instructions"] == "Close your eyes and breathe"


@pytest.mark.asyncio
async def test_get_practice_not_found(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client)
    resp = await async_client.get("/practices/999", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


# -- Submit practice --------------------------------------------------------


@pytest.mark.asyncio
async def test_submit_practice(async_client: AsyncClient) -> None:
    headers, _user_id = await _signup(async_client)
    payload = {
        "stage_number": 1,
        "name": "My Custom Practice",
        "description": "Something personal",
        "instructions": "Do this then that",
        "default_duration_minutes": 15,
    }
    resp = await async_client.post("/practices/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    data = resp.json()
    assert data["name"] == "My Custom Practice"
    # BUG-PRACTICE-001 / BUG-SCHEMA-010: catalog responses must not leak the
    # submitter's user id.  Server-side ownership lives on the row.
    assert "submitted_by_user_id" not in data
    assert data["approved"] is False


@pytest.mark.asyncio
async def test_submitted_practice_not_in_listings(
    async_client: AsyncClient,
) -> None:
    headers, _ = await _signup(async_client)
    payload = {
        "stage_number": 1,
        "name": "My Custom Practice",
        "description": "Something personal",
        "instructions": "Do this then that",
        "default_duration_minutes": 15,
    }
    await async_client.post("/practices/", json=payload, headers=headers)

    resp = await async_client.get("/practices/", params={"stage_number": 1}, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert len(resp.json()) == 0
