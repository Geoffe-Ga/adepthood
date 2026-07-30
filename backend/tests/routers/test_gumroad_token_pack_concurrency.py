"""Concurrency test for the Gumroad token-pack credit path.

Gumroad retries a ping it believes was not acknowledged, so five identical
deliveries can land at once. The invariant asserted here is the outcome, not
the mechanism: whatever guard the implementation uses, the buyer's wallet
gains exactly one pack, exactly one ``gumroad_purchase`` audit row exists,
and the single stored sale ends up claimed.
"""

from __future__ import annotations

import asyncio
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import select

from domain.entitlements import TOKEN_PACK_PRODUCT_IDS_ENV_VAR, TOKEN_PACK_SIZES_ENV_VAR
from models.gumroad_sale import GumroadSale
from models.user import User
from models.wallet_audit import REASON_GUMROAD_PURCHASE, WalletAudit

WEBHOOK_PATH = "/webhooks/gumroad/ping"
WEBHOOK_SECRET = "gumroad-concurrency-shared-secret"  # pragma: allowlist secret
WEBHOOK_SECRET_ENV_VAR = "GUMROAD_WEBHOOK_SECRET"  # pragma: allowlist secret
BUYER_EMAIL = "concurrent-buyer@example.com"
PACK_PRODUCT_ID = "prod_pack_concurrent"
PACK_SIZE = 100
SALE_ID = "S-CONCURRENT-1"
CONCURRENT_PINGS = 5


@pytest.fixture(autouse=True)
def token_pack_webhook_config(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure the shared secret and the single sized token-pack product."""
    monkeypatch.setenv(WEBHOOK_SECRET_ENV_VAR, WEBHOOK_SECRET)
    monkeypatch.setenv(TOKEN_PACK_PRODUCT_IDS_ENV_VAR, PACK_PRODUCT_ID)
    monkeypatch.setenv(TOKEN_PACK_SIZES_ENV_VAR, f"{PACK_PRODUCT_ID}:{PACK_SIZE}")


def _ping_payload() -> dict[str, str]:
    """Build the token-pack sale ping every concurrent delivery repeats."""
    return {
        "sale_id": SALE_ID,
        "product_id": PACK_PRODUCT_ID,
        "email": BUYER_EMAIL,
        "resource_name": "sale",
        "is_recurring_charge": "false",
        "refunded": "false",
    }


async def _seed_buyer(factory: async_sessionmaker[AsyncSession]) -> int:
    """Insert the buyer into the concurrency engine and return their id."""
    async with factory() as session:
        user = User(email=BUYER_EMAIL, password_hash="x")  # pragma: allowlist secret
        session.add(user)
        await session.commit()
        await session.refresh(user)
        if user.id is None:
            msg = "user id missing after commit"
            raise RuntimeError(msg)
        return user.id


@pytest.mark.asyncio
async def test_concurrent_token_pack_pings_credit_exactly_one_pack(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Five simultaneous deliveries of one sale credit the wallet exactly once."""
    user_id = await _seed_buyer(concurrent_session_factory)

    responses = await asyncio.gather(
        *[
            concurrent_async_client.post(
                WEBHOOK_PATH, params={"secret": WEBHOOK_SECRET}, data=_ping_payload()
            )
            for _ in range(CONCURRENT_PINGS)
        ]
    )

    assert [response.status_code for response in responses] == [HTTPStatus.OK] * CONCURRENT_PINGS

    async with concurrent_session_factory() as session:
        balance = (
            await session.execute(select(User.offering_balance).where(User.id == user_id))
        ).scalar_one()
        assert int(balance) == PACK_SIZE

        audit_count = (
            await session.execute(
                select(func.count())
                .select_from(WalletAudit)
                .where(WalletAudit.reason == REASON_GUMROAD_PURCHASE)
            )
        ).scalar_one()
        assert int(audit_count) == 1

        sale = (await session.execute(select(GumroadSale))).scalars().one()
        assert sale.gumroad_sale_id == SALE_ID
        assert sale.token_pack_credited_at is not None
        assert sale.token_pack_credited_user_id == user_id
