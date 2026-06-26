"""Tests for the admin energy-plan retention endpoint."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.energy_plan import EnergyPlan as EnergyPlanRecord
from models.user import User
from services.energy import ENERGY_PLAN_RETENTION_DAYS


async def _signup(client: AsyncClient, email: str) -> tuple[int, dict[str, str]]:
    resp = await client.post(
        "/auth/signup",
        json={"email": email, "password": "secret12345"},  # pragma: allowlist secret
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return int(body["user_id"]), {"Authorization": f"Bearer {body['token']}"}


async def _signup_admin(
    client: AsyncClient, db_session: AsyncSession
) -> tuple[int, dict[str, str]]:
    user_id, headers = await _signup(client, "admin@example.com")
    await db_session.execute(
        update(User).where(col(User.email) == "admin@example.com").values(is_admin=True)
    )
    await db_session.commit()
    return user_id, headers


def _plan(user_id: int, *, age_days: int) -> EnergyPlanRecord:
    return EnergyPlanRecord(
        user_id=user_id,
        idempotency_key=None,
        plan_json="{}",
        reason_code="ok",
        created_at=datetime.now(UTC) - timedelta(days=age_days),
    )


@pytest.mark.asyncio
async def test_cleanup_requires_admin(async_client: AsyncClient) -> None:
    """A non-admin user is rejected."""
    _uid, headers = await _signup(async_client, "plain@example.com")
    resp = await async_client.post("/admin/maintenance/energy-plans", headers=headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_cleanup_deletes_expired_rows(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Admin sweep deletes rows past the window and reports the count."""
    admin_id, headers = await _signup_admin(async_client, db_session)
    db_session.add_all(
        [_plan(admin_id, age_days=ENERGY_PLAN_RETENTION_DAYS + 5), _plan(admin_id, age_days=1)]
    )
    await db_session.commit()

    resp = await async_client.post("/admin/maintenance/energy-plans", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["deleted"] == 1
    assert body["older_than_days"] == ENERGY_PLAN_RETENTION_DAYS

    remaining = (await db_session.execute(select(EnergyPlanRecord))).scalars().all()
    assert len(remaining) == 1


@pytest.mark.asyncio
async def test_cleanup_rejects_non_positive_window(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A non-positive window is a 400, not a delete-everything footgun."""
    _admin_id, headers = await _signup_admin(async_client, db_session)
    resp = await async_client.post(
        "/admin/maintenance/energy-plans",
        params={"older_than_days": 0},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST
