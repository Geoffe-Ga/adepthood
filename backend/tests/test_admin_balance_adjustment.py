"""Admin wallet adjustments: arbitrary targets, auditability and safe retries."""

from __future__ import annotations

import logging
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.admin_balance_adjustment import AdminBalanceAdjustment
from models.user import User
from models.wallet_audit import REASON_ADMIN_ADJUSTMENT, WalletAudit


async def _signup(client: AsyncClient, email: str) -> tuple[int, dict[str, str]]:
    response = await client.post(
        "/auth/signup",
        json={"email": email, "password": "correct-horse-battery"},
    )
    assert response.status_code == HTTPStatus.OK, response.text
    body = response.json()
    return int(body["user_id"]), {"Authorization": f"Bearer {body['token']}"}


async def _admin(
    client: AsyncClient, session: AsyncSession, email: str = "wallet-admin@example.com"
) -> tuple[int, dict[str, str]]:
    user_id, headers = await _signup(client, email)
    await session.execute(update(User).where(col(User.id) == user_id).values(is_admin=True))
    await session.commit()
    return user_id, headers


async def _target(session: AsyncSession, email: str, *, balance: int = 0) -> User:
    user = User(email=email, password_hash="fixture-hash", offering_balance=balance)
    session.add(user)
    await session.commit()
    await session.refresh(user)
    assert user.id is not None
    return user


@pytest.mark.asyncio
async def test_admin_can_adjust_another_users_balance_and_both_audits_land(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The endpoint replaces SQL while retaining the actor and operator's reason."""
    admin_id, headers = await _admin(async_client, db_session)
    target = await _target(db_session, "wallet-target@example.com", balance=7)
    target_id = target.id

    response = await async_client.post(
        f"/admin/users/{target_id}/tokens",
        json={"delta": 5, "reason": "support goodwill after outage"},
        headers={**headers, "X-Idempotency-Key": "ticket-4821"},
    )

    assert response.status_code == HTTPStatus.OK, response.text
    assert response.json() == {"user_id": target_id, "balance": 12}
    db_session.expire_all()
    stored_target = await db_session.get(User, target_id)
    assert stored_target is not None
    assert stored_target.offering_balance == 12

    wallet_row = (
        await db_session.execute(select(WalletAudit).where(col(WalletAudit.user_id) == target_id))
    ).scalar_one()
    assert wallet_row.actor_user_id == admin_id
    assert wallet_row.reason == REASON_ADMIN_ADJUSTMENT
    assert int(wallet_row.delta) == 5
    assert int(wallet_row.balance_before) == 7
    assert int(wallet_row.balance_after) == 12

    adjustment = (
        await db_session.execute(
            select(AdminBalanceAdjustment).where(
                col(AdminBalanceAdjustment.target_user_id) == target_id
            )
        )
    ).scalar_one()
    assert adjustment.actor_admin_id == admin_id
    assert adjustment.delta == 5
    assert adjustment.reason == "support goodwill after outage"
    assert adjustment.balance_after == 12
    assert adjustment.source_ip == "127.0.0.1"
    assert adjustment.idempotency_key is not None
    assert adjustment.idempotency_key != "ticket-4821"


@pytest.mark.asyncio
async def test_admin_adjustment_allows_a_negative_balance(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Corrective debits are unclamped so prior spending cannot erase a debt."""
    _, headers = await _admin(async_client, db_session, "debit-admin@example.com")
    target = await _target(db_session, "debit-target@example.com", balance=2)

    response = await async_client.post(
        f"/admin/users/{target.id}/tokens",
        json={"delta": -5, "reason": "correct duplicate courtesy credit"},
        headers=headers,
    )

    assert response.status_code == HTTPStatus.OK, response.text
    assert response.json()["balance"] == -3


@pytest.mark.asyncio
async def test_admin_adjustment_exact_retry_returns_original_result_once(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A transport retry neither double-charges nor manufactures a second audit row."""
    _, headers = await _admin(async_client, db_session, "retry-admin@example.com")
    target = await _target(db_session, "retry-target@example.com", balance=4)
    target_id = target.id
    request_headers = {**headers, "X-Idempotency-Key": "case-90210"}
    payload = {"delta": 6, "reason": "conference access recovery"}

    first = await async_client.post(
        f"/admin/users/{target_id}/tokens", json=payload, headers=request_headers
    )
    second = await async_client.post(
        f"/admin/users/{target_id}/tokens", json=payload, headers=request_headers
    )

    assert first.status_code == HTTPStatus.OK, first.text
    assert second.status_code == HTTPStatus.OK, second.text
    assert second.json() == first.json() == {"user_id": target_id, "balance": 10}
    assert (
        len(
            list(
                (
                    await db_session.execute(
                        select(WalletAudit).where(col(WalletAudit.user_id) == target_id)
                    )
                )
                .scalars()
                .all()
            )
        )
        == 1
    )
    assert (
        len(
            list(
                (
                    await db_session.execute(
                        select(AdminBalanceAdjustment).where(
                            col(AdminBalanceAdjustment.target_user_id) == target_id
                        )
                    )
                )
                .scalars()
                .all()
            )
        )
        == 1
    )


@pytest.mark.asyncio
async def test_admin_adjustment_rejects_key_reuse_for_a_different_operation(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A key binds target, delta and reason; changing any of them is a conflict."""
    _, headers = await _admin(async_client, db_session, "conflict-admin@example.com")
    first_target = await _target(db_session, "conflict-one@example.com")
    second_target = await _target(db_session, "conflict-two@example.com")
    second_target_id = second_target.id
    request_headers = {**headers, "X-Idempotency-Key": "shared-support-case"}

    first = await async_client.post(
        f"/admin/users/{first_target.id}/tokens",
        json={"delta": 3, "reason": "first correction"},
        headers=request_headers,
    )
    conflict = await async_client.post(
        f"/admin/users/{second_target.id}/tokens",
        json={"delta": 3, "reason": "first correction"},
        headers=request_headers,
    )

    assert first.status_code == HTTPStatus.OK, first.text
    assert conflict.status_code == HTTPStatus.CONFLICT, conflict.text
    assert conflict.json() == {"detail": "idempotency_key_reused"}
    db_session.expire_all()
    unchanged = await db_session.get(User, second_target_id)
    assert unchanged is not None
    assert unchanged.offering_balance == 0


@pytest.mark.asyncio
async def test_admin_adjustment_validates_authority_target_delta_and_reason(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Every malformed or unauthorized write is rejected before wallet mutation."""
    target = await _target(db_session, "validation-target@example.com", balance=9)
    target_id = target.id
    _, plain_headers = await _signup(async_client, "plain-wallet-user@example.com")
    _, admin_headers = await _admin(async_client, db_session, "validation-admin@example.com")
    payload = {"delta": 2, "reason": "documented correction"}

    anonymous = await async_client.post(f"/admin/users/{target.id}/tokens", json=payload)
    forbidden = await async_client.post(
        f"/admin/users/{target.id}/tokens", json=payload, headers=plain_headers
    )
    missing = await async_client.post(
        "/admin/users/2147483647/tokens", json=payload, headers=admin_headers
    )
    zero = await async_client.post(
        f"/admin/users/{target.id}/tokens",
        json={"delta": 0, "reason": "no operation"},
        headers=admin_headers,
    )
    blank = await async_client.post(
        f"/admin/users/{target.id}/tokens",
        json={"delta": 2, "reason": "   "},
        headers=admin_headers,
    )

    assert anonymous.status_code in {HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN}
    assert forbidden.status_code == HTTPStatus.FORBIDDEN
    assert missing.status_code == HTTPStatus.NOT_FOUND
    assert zero.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert blank.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    db_session.expire_all()
    unchanged = await db_session.get(User, target_id)
    assert unchanged is not None
    assert unchanged.offering_balance == 9


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("balance", "delta"),
    [
        (2_147_483_647, 1),
        (-2_147_483_648, -1),
    ],
)
async def test_admin_adjustment_refuses_integer_overflow_without_an_audit(
    async_client: AsyncClient,
    db_session: AsyncSession,
    balance: int,
    delta: int,
) -> None:
    """An adjustment can go negative, but the persisted integer must stay representable."""
    _, headers = await _admin(async_client, db_session, "bounds-admin@example.com")
    target = await _target(db_session, "bounds-target@example.com", balance=balance)

    response = await async_client.post(
        f"/admin/users/{target.id}/tokens",
        json={"delta": delta, "reason": "would overflow storage"},
        headers=headers,
    )

    assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY, response.text
    assert response.json() == {"detail": "balance_out_of_range"}
    assert (
        await db_session.execute(select(WalletAudit).where(col(WalletAudit.user_id) == target.id))
    ).scalars().first() is None
    assert (
        await db_session.execute(
            select(AdminBalanceAdjustment).where(
                col(AdminBalanceAdjustment.target_user_id) == target.id
            )
        )
    ).scalars().first() is None


@pytest.mark.asyncio
async def test_admin_adjustment_emits_structured_operator_audit(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The durable rows and log stream name the same actor, target and reason."""
    admin_id, headers = await _admin(async_client, db_session, "logging-admin@example.com")
    target = await _target(db_session, "logging-target@example.com")
    reason = "restore credits after provider incident"

    with caplog.at_level(logging.WARNING, logger="routers.admin"):
        response = await async_client.post(
            f"/admin/users/{target.id}/tokens",
            json={"delta": 8, "reason": reason},
            headers=headers,
        )

    assert response.status_code == HTTPStatus.OK, response.text
    record = next(record for record in caplog.records if record.msg == "admin_balance_adjusted")
    assert record.__dict__["actor"] == admin_id
    assert record.__dict__["action"] == "adjust_balance"
    assert record.__dict__["target_user_id"] == target.id
    assert record.__dict__["delta"] == 8
    assert record.__dict__["reason"] == reason
    assert record.__dict__["source_ip"] == "127.0.0.1"
