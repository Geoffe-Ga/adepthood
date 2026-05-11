"""Tests for the PATCH /user-practices/{id}/customize endpoint."""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.practice import Practice
from models.stage_progress import StageProgress
from models.user_practice import UserPractice


async def _signup(client: AsyncClient, username: str = "owner") -> tuple[dict[str, str], int]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, body["user_id"]


def _timer_cfg(duration_minutes: float = 10) -> dict[str, object]:
    return {
        "mode": "meditation_timer",
        "duration_minutes": duration_minutes,
        "start_bell": True,
        "halfway_bell": False,
        "end_bell": True,
    }


async def _seed_practice(db_session: AsyncSession, **overrides: object) -> Practice:
    fields: dict[str, object] = {
        "stage_number": 1,
        "name": "Catalog meditation",
        "description": "x",
        "instructions": "x",
        "default_duration_minutes": 10,
        "approved": True,
        "mode": "meditation_timer",
        "mode_config": _timer_cfg(10),
    }
    fields.update(overrides)
    practice = Practice(**fields)
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)
    return practice


async def _create_user_practice(
    client: AsyncClient,
    db_session: AsyncSession,
    headers: dict[str, str],
    user_id: int,
    practice: Practice,
) -> int:
    """Select a practice and return the resulting user_practice_id."""
    db_session.add(StageProgress(user_id=user_id, current_stage=practice.stage_number))
    await db_session.commit()
    resp = await client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": practice.stage_number},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED, resp.text
    return int(resp.json()["id"])


# -- Happy paths ------------------------------------------------------------


@pytest.mark.asyncio
async def test_customize_sets_custom_name(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)

    resp = await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"custom_name": "My Morning Sit"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body["effective_name"] == "My Morning Sit"

    # GET reflects the change.
    refetch = await async_client.get(f"/user-practices/{up_id}", headers=headers)
    assert refetch.json()["effective_name"] == "My Morning Sit"


@pytest.mark.asyncio
async def test_customize_sets_mode_config_override(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)

    override = {**_timer_cfg(25), "halfway_bell": True}
    resp = await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"mode_config_override": override},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    eff_cfg = resp.json()["effective_config"]
    assert eff_cfg["duration_minutes"] == 25
    assert eff_cfg["halfway_bell"] is True


@pytest.mark.asyncio
async def test_customize_clears_override_with_explicit_null(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)

    # Set an override first.
    await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"mode_config_override": {**_timer_cfg(25)}},
        headers=headers,
    )
    # Then clear it.
    resp = await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"mode_config_override": None},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["effective_config"]["duration_minutes"] == 10  # catalog default

    # And the underlying override column is null.
    persisted = await db_session.get(UserPractice, up_id)
    assert persisted is not None
    await db_session.refresh(persisted)
    assert persisted.mode_config_override is None


@pytest.mark.asyncio
async def test_customize_does_not_mutate_catalog_practice(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Customization must never touch the shared :class:`Practice` row."""
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    catalog_name_before = practice.name
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)

    await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"custom_name": "Renamed", "mode_config_override": _timer_cfg(60)},
        headers=headers,
    )
    await db_session.refresh(practice)
    assert practice.name == catalog_name_before
    assert practice.mode_config["duration_minutes"] == 10  # unchanged


# -- Error paths ------------------------------------------------------------


@pytest.mark.asyncio
async def test_customize_rejects_mode_mismatch(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)

    resp = await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"mode_config_override": {"mode": "count_up"}},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST
    assert "mode_mismatch" in resp.text


@pytest.mark.asyncio
async def test_customize_rejects_invalid_mode_config(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)

    bad = {**_timer_cfg(10), "duration_minutes": 0.0}  # below 0.5 minimum
    resp = await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"mode_config_override": bad},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_customize_403_on_other_user(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    owner_headers, owner_id = await _signup(async_client, username="owner")
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, owner_headers, owner_id, practice)

    intruder_headers, _ = await _signup(async_client, username="intruder")
    resp = await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"custom_name": "stolen"},
        headers=intruder_headers,
    )
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_customize_404_on_missing_id(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client)
    resp = await async_client.patch(
        "/user-practices/9999/customize",
        json={"custom_name": "ghost"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_customize_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.patch(
        "/user-practices/1/customize",
        json={"custom_name": "x"},
    )
    assert resp.status_code == HTTPStatus.UNAUTHORIZED
