"""Retention/cleanup for persisted energy plans (audit-destub follow-up)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.energy_plan import EnergyPlan as EnergyPlanRecord
from services.energy import ENERGY_PLAN_RETENTION_DAYS, delete_expired_energy_plans

_OLD_DAYS = ENERGY_PLAN_RETENTION_DAYS + 10
_RECENT_DAYS = ENERGY_PLAN_RETENTION_DAYS - 10


async def _signup(client: AsyncClient) -> int:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": "retention@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return int(resp.json()["user_id"])


def _plan(user_id: int, *, age_days: int, key: str | None) -> EnergyPlanRecord:
    return EnergyPlanRecord(
        user_id=user_id,
        idempotency_key=key,
        plan_json="{}",
        reason_code="ok",
        created_at=datetime.now(UTC) - timedelta(days=age_days),
    )


@pytest.mark.asyncio
async def test_delete_expired_energy_plans_removes_only_old_rows(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Rows past the retention window are deleted; newer rows are kept."""
    user_id = await _signup(async_client)
    db_session.add_all(
        [
            _plan(user_id, age_days=_OLD_DAYS, key=None),  # unkeyed, expired
            _plan(user_id, age_days=_OLD_DAYS, key="old-key"),  # keyed, expired
            _plan(user_id, age_days=_RECENT_DAYS, key=None),  # unkeyed, fresh
        ]
    )
    await db_session.commit()

    deleted = await delete_expired_energy_plans(db_session)

    assert deleted == 2
    remaining = (await db_session.execute(select(EnergyPlanRecord))).scalars().all()
    # Both expired rows (the unkeyed and the keyed) are gone; only the fresh
    # unkeyed row survives — the lone remaining row.
    assert len(remaining) == 1
    assert remaining[0].idempotency_key is None


@pytest.mark.asyncio
async def test_delete_expired_energy_plans_custom_window(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A tighter window deletes a row the default window would keep."""
    user_id = await _signup(async_client)
    db_session.add(_plan(user_id, age_days=_RECENT_DAYS, key=None))
    await db_session.commit()

    assert await delete_expired_energy_plans(db_session, older_than_days=1) == 1
    assert (await db_session.execute(select(EnergyPlanRecord))).scalars().first() is None
