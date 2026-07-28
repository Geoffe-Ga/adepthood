"""Signup-time claim of token packs bought before the buyer had an account.

Contract: a token-pack sale that arrives while nobody owns the email waits
unclaimed on the ``GumroadSale`` row; the first signup for that email sweeps
every waiting pack into ``offering_balance`` exactly once, matching the buyer
email case-insensitively and skipping refunded or already-claimed rows. A
signup with nothing waiting is an ordinary signup with a zero balance.

This module deliberately rides the default stub-open license gate, so signup
succeeds without a live Gumroad verify call.
"""

from __future__ import annotations

from datetime import UTC, datetime
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from domain.entitlements import TOKEN_PACK_PRODUCT_IDS_ENV_VAR, TOKEN_PACK_SIZES_ENV_VAR
from models.gumroad_sale import SALE_RESOURCE_NAME, GumroadSale
from models.user import User
from models.wallet_audit import REASON_GUMROAD_PURCHASE, WalletAudit

WEBHOOK_PATH = "/webhooks/gumroad/ping"
SIGNUP_PATH = "/auth/signup"
WEBHOOK_SECRET = "signup-claim-shared-secret"  # pragma: allowlist secret
WEBHOOK_SECRET_ENV_VAR = "GUMROAD_WEBHOOK_SECRET"  # pragma: allowlist secret
BUYER_EMAIL = "late-buyer@example.com"
MIXED_CASE_BUYER_EMAIL = "Late-Buyer@Example.COM"
SIGNUP_PASSWORD = "securepassword123"  # pragma: allowlist secret
LICENSE_KEY = "SIGNUP-CLAIM-TEST-KEY"  # pragma: allowlist secret
PACK_PRODUCT_ID = "prod_pack_small"
SECOND_PACK_PRODUCT_ID = "prod_pack_large"
PACK_SIZE = 100
SECOND_PACK_SIZE = 250
SALE_ID = "S-700"
SECOND_SALE_ID = "S-701"


@pytest.fixture(autouse=True)
def token_pack_webhook_config(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure the shared secret and both sized token-pack products."""
    monkeypatch.setenv(WEBHOOK_SECRET_ENV_VAR, WEBHOOK_SECRET)
    monkeypatch.setenv(
        TOKEN_PACK_PRODUCT_IDS_ENV_VAR,
        f"{PACK_PRODUCT_ID},{SECOND_PACK_PRODUCT_ID}",
    )
    monkeypatch.setenv(
        TOKEN_PACK_SIZES_ENV_VAR,
        f"{PACK_PRODUCT_ID}:{PACK_SIZE},{SECOND_PACK_PRODUCT_ID}:{SECOND_PACK_SIZE}",
    )


def _pack_payload(
    *,
    sale_id: str = SALE_ID,
    product_id: str = PACK_PRODUCT_ID,
    email: str = BUYER_EMAIL,
    refunded: str = "false",
) -> dict[str, str]:
    """Build a token-pack sale ping payload."""
    return {
        "sale_id": sale_id,
        "product_id": product_id,
        "email": email,
        "resource_name": SALE_RESOURCE_NAME,
        "is_recurring_charge": "false",
        "refunded": refunded,
    }


async def _post_ping(client: AsyncClient, payload: dict[str, str]) -> None:
    """Deliver one authenticated ping and assert it was accepted."""
    response = await client.post(WEBHOOK_PATH, params={"secret": WEBHOOK_SECRET}, data=payload)
    assert response.status_code == HTTPStatus.OK


async def _signup(client: AsyncClient, email: str = BUYER_EMAIL) -> int:
    """Sign up ``email`` and return the created user id."""
    response = await client.post(
        SIGNUP_PATH,
        json={"email": email, "password": SIGNUP_PASSWORD, "license_key": LICENSE_KEY},
    )
    assert response.status_code == HTTPStatus.OK
    return int(response.json()["user_id"])


async def _balance(db_session: AsyncSession, user_id: int) -> int:
    """Return the user's persisted offering balance, read fresh."""
    result = await db_session.execute(
        select(User).where(User.id == user_id).execution_options(populate_existing=True)
    )
    return int(result.scalars().one().offering_balance)


async def _count_purchase_audits(db_session: AsyncSession) -> int:
    """Count only ``gumroad_purchase`` audit rows so other reasons cannot skew."""
    result = await db_session.execute(
        select(func.count())
        .select_from(WalletAudit)
        .where(WalletAudit.reason == REASON_GUMROAD_PURCHASE)
    )
    return int(result.scalar_one())


async def _reload_sale(db_session: AsyncSession, sale_id: str) -> GumroadSale:
    """Re-read one sale row from the database, bypassing the identity map."""
    result = await db_session.execute(
        select(GumroadSale)
        .where(GumroadSale.gumroad_sale_id == sale_id)
        .execution_options(populate_existing=True)
    )
    return result.scalars().one()


async def _seed_claimed_sale(db_session: AsyncSession) -> None:
    """Persist a token-pack sale that some earlier pass already credited."""
    sale = GumroadSale(
        gumroad_sale_id=SALE_ID,
        product_id=PACK_PRODUCT_ID,
        email=BUYER_EMAIL,
        resource_name=SALE_RESOURCE_NAME,
        raw_payload={"sale_id": SALE_ID},
        token_pack_credited_at=datetime.now(UTC),
    )
    db_session.add(sale)
    await db_session.commit()


@pytest.mark.asyncio
async def test_signup_claims_pack_bought_before_the_account_existed(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The first signup for the buyer's email sweeps the waiting pack in."""
    await _post_ping(async_client, _pack_payload())

    user_id = await _signup(async_client)

    assert await _balance(db_session, user_id) == PACK_SIZE
    assert await _count_purchase_audits(db_session) == 1
    sale = await _reload_sale(db_session, SALE_ID)
    assert sale.token_pack_credited_user_id == user_id
    assert sale.token_pack_credited_at is not None


@pytest.mark.asyncio
async def test_signup_claims_pack_bought_under_a_mixed_case_email(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Gumroad's mixed-case buyer email still matches the normalized account."""
    await _post_ping(async_client, _pack_payload(email=MIXED_CASE_BUYER_EMAIL))

    user_id = await _signup(async_client)

    assert await _balance(db_session, user_id) == PACK_SIZE
    assert await _count_purchase_audits(db_session) == 1


@pytest.mark.asyncio
async def test_signup_claims_every_waiting_pack(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Two waiting packs sum into the opening balance and both get claimed."""
    await _post_ping(async_client, _pack_payload())
    await _post_ping(
        async_client,
        _pack_payload(sale_id=SECOND_SALE_ID, product_id=SECOND_PACK_PRODUCT_ID),
    )

    user_id = await _signup(async_client)

    assert await _balance(db_session, user_id) == PACK_SIZE + SECOND_PACK_SIZE
    assert await _count_purchase_audits(db_session) == 2
    for sale_id in (SALE_ID, SECOND_SALE_ID):
        sale = await _reload_sale(db_session, sale_id)
        assert sale.token_pack_credited_user_id == user_id


@pytest.mark.asyncio
async def test_signup_does_not_claim_a_refunded_pack(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A refunded purchase must not fund the account it was refunded from."""
    await _post_ping(async_client, _pack_payload(refunded="true"))

    user_id = await _signup(async_client)

    assert await _balance(db_session, user_id) == 0
    assert await _count_purchase_audits(db_session) == 0
    sale = await _reload_sale(db_session, SALE_ID)
    assert sale.token_pack_credited_at is None


@pytest.mark.asyncio
async def test_signup_does_not_recredit_an_already_claimed_pack(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A sale stamped as credited is never swept a second time."""
    await _seed_claimed_sale(db_session)

    user_id = await _signup(async_client)

    assert await _balance(db_session, user_id) == 0
    assert await _count_purchase_audits(db_session) == 0


@pytest.mark.asyncio
async def test_signup_with_no_waiting_packs_starts_at_zero_balance(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The empty sweep path must not break an otherwise ordinary signup."""
    user_id = await _signup(async_client)

    assert await _balance(db_session, user_id) == 0
    assert await _count_purchase_audits(db_session) == 0


@pytest.mark.asyncio
async def test_signup_then_webhook_credits_once_across_a_replay(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """When the account exists first the webhook credits it, and a replay does not."""
    user_id = await _signup(async_client)
    assert await _balance(db_session, user_id) == 0

    await _post_ping(async_client, _pack_payload())
    await _post_ping(async_client, _pack_payload())

    assert await _balance(db_session, user_id) == PACK_SIZE
    assert await _count_purchase_audits(db_session) == 1
