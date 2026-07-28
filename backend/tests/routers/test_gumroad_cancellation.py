"""Cancellation / subscription-ended handling for POST /webhooks/gumroad/ping.

Contract: a ``cancellation`` or ``subscription_ended`` ping ends future access
without reversing money. It applies ONLY to an APTITUDE sale — a subscription
is the only thing there is to cancel. The buyer's ``course_access`` is revoked
(unless another live APTITUDE purchase still covers it), the original sale
keeps ``refunded`` False because the seller kept the payment, and the wallet is
never touched.

A cancellation naming a token-pack sale (or any product on neither allowlist)
is wholly inert: one-time purchases cannot be cancelled, so the handler takes
no claim, writes nothing, and logs ``cancellation_not_applicable``. Staying
inert is what protects the money — the pack sale keeps its unspent
``revocation_processed_at`` claim, so a genuine later refund still claws the
credits back in full.

On the APTITUDE side, cancellation and refund do share that single
exactly-once claim, so whichever lands first wins and the other becomes a
no-op rather than revoking twice.
"""

from __future__ import annotations

import logging
from decimal import Decimal
from http import HTTPStatus

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.entitlements import (
    PRODUCT_IDS_ENV_VAR,
    TOKEN_PACK_PRODUCT_IDS_ENV_VAR,
    TOKEN_PACK_SIZES_ENV_VAR,
)
from models.entitlement import Entitlement
from models.gumroad_sale import SALE_RESOURCE_NAME, GumroadSale
from models.user import User
from models.wallet_audit import REASON_GUMROAD_REFUND, WalletAudit

WEBHOOK_PATH = "/webhooks/gumroad/ping"
WEBHOOK_SECRET = "gumroad-cancellation-shared-secret-test-only"  # pragma: allowlist secret
WRONG_WEBHOOK_SECRET = "not-the-shared-secret"  # pragma: allowlist secret
WEBHOOK_SECRET_ENV_VAR = "GUMROAD_WEBHOOK_SECRET"  # pragma: allowlist secret

APTITUDE_PRODUCT_ID = "prod_course_abc"
SECOND_APTITUDE_PRODUCT_ID = "prod_course_xyz"
TOKEN_PACK_PRODUCT_ID = "prod_pack_small"
TOKEN_PACK_SIZE = 100

BUYER_EMAIL = "buyer@example.com"
MIXED_CASE_BUYER_EMAIL = "Buyer@Example.COM"

SALE_ID = "S-100"
SECOND_SALE_ID = "S-101"
PACK_SALE_ID = "S-200"
UNKNOWN_SALE_ID = "S-999"

CANCELLATION_RESOURCE = "cancellation"
SUBSCRIPTION_ENDED_RESOURCE = "subscription_ended"
REFUND_RESOURCE = "refund"

UNKNOWN_SALE_MARKER = "unknown_sale"
COVERED_MARKER = "covered_by_other_sale"
NOT_APPLICABLE_MARKER = "cancellation_not_applicable"

EXPECTED_SALES_AFTER_ORPHAN_CANCELLATION = 2


@pytest.fixture(autouse=True)
def gumroad_config(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure the shared secret and both product allowlists for every test."""
    monkeypatch.setenv(WEBHOOK_SECRET_ENV_VAR, WEBHOOK_SECRET)
    monkeypatch.setenv(PRODUCT_IDS_ENV_VAR, f"{APTITUDE_PRODUCT_ID},{SECOND_APTITUDE_PRODUCT_ID}")
    monkeypatch.setenv(TOKEN_PACK_PRODUCT_IDS_ENV_VAR, TOKEN_PACK_PRODUCT_ID)
    monkeypatch.setenv(TOKEN_PACK_SIZES_ENV_VAR, f"{TOKEN_PACK_PRODUCT_ID}:{TOKEN_PACK_SIZE}")


def _sale_payload(**overrides: str) -> dict[str, str]:
    """Build a form-encoded APTITUDE sale ping, with optional overrides."""
    payload = {
        "sale_id": SALE_ID,
        "product_id": APTITUDE_PRODUCT_ID,
        "email": BUYER_EMAIL,
        "resource_name": SALE_RESOURCE_NAME,
        "is_recurring_charge": "false",
        "refunded": "false",
    }
    payload.update(overrides)
    return payload


def _pack_payload(**overrides: str) -> dict[str, str]:
    """Build a token-pack sale ping, with optional overrides."""
    defaults = {"sale_id": PACK_SALE_ID, "product_id": TOKEN_PACK_PRODUCT_ID}
    return _sale_payload(**{**defaults, **overrides})


def _cancellation_payload(**overrides: str) -> dict[str, str]:
    """Build a cancellation ping for the default APTITUDE sale."""
    return _sale_payload(**{"resource_name": CANCELLATION_RESOURCE, **overrides})


async def _ping(
    client: AsyncClient,
    payload: dict[str, str],
    secret: str = WEBHOOK_SECRET,
) -> Response:
    """POST one form-encoded ping with the given shared secret."""
    return await client.post(WEBHOOK_PATH, params={"secret": secret}, data=payload)


def _log_carries_marker(caplog: pytest.LogCaptureFixture, marker: str) -> bool:
    """Return True when ``marker`` appears in captured text or as a reason_code."""
    if marker in caplog.text:
        return True
    return any(getattr(record, "reason_code", None) == marker for record in caplog.records)


async def _persist_user(db_session: AsyncSession, email: str = BUYER_EMAIL) -> int:
    """Create and commit a user; return their non-null id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    if user.id is None:
        msg = "user id missing after commit"
        raise RuntimeError(msg)
    return user.id


async def _offering_balance(db_session: AsyncSession, user_id: int) -> int:
    """Return the user's persisted offering balance, read fresh."""
    result = await db_session.execute(
        select(User).where(col(User.id) == user_id).execution_options(populate_existing=True)
    )
    return int(result.scalars().one().offering_balance)


async def _reload_sale(db_session: AsyncSession, sale_id: str) -> GumroadSale:
    """Re-read one sale row from the database, bypassing the identity map."""
    result = await db_session.execute(
        select(GumroadSale)
        .where(col(GumroadSale.gumroad_sale_id) == sale_id)
        .execution_options(populate_existing=True)
    )
    return result.scalars().one()


async def _entitlements(db_session: AsyncSession) -> list[Entitlement]:
    """Return every entitlement row, read fresh and ordered by insertion."""
    result = await db_session.execute(
        select(Entitlement).order_by(col(Entitlement.id)).execution_options(populate_existing=True)
    )
    return list(result.scalars().all())


async def _sole_entitlement(db_session: AsyncSession) -> Entitlement:
    """Return the single entitlement row, failing loudly if there is not exactly one."""
    entitlements = await _entitlements(db_session)
    assert len(entitlements) == 1
    return entitlements[0]


async def _refund_audits(db_session: AsyncSession) -> list[WalletAudit]:
    """Return only the ``gumroad_refund`` audit rows, oldest first."""
    result = await db_session.execute(
        select(WalletAudit)
        .where(col(WalletAudit.reason) == REASON_GUMROAD_REFUND)
        .order_by(col(WalletAudit.id))
        .execution_options(populate_existing=True)
    )
    return list(result.scalars().all())


async def _count_sales(db_session: AsyncSession) -> int:
    """Return the number of GumroadSale rows in the test database."""
    result = await db_session.execute(select(func.count()).select_from(GumroadSale))
    return int(result.scalar_one())


@pytest.mark.asyncio
@pytest.mark.parametrize("resource_name", [CANCELLATION_RESOURCE, SUBSCRIPTION_ENDED_RESOURCE])
async def test_ending_event_revokes_course_access_without_a_refund(
    async_client: AsyncClient,
    db_session: AsyncSession,
    resource_name: str,
) -> None:
    """Cancelling ends access but leaves the sale unrefunded — the money was kept."""
    user_id = await _persist_user(db_session)
    await _ping(async_client, _sale_payload())

    response = await _ping(async_client, _cancellation_payload(resource_name=resource_name))

    assert response.status_code == HTTPStatus.OK
    entitlement = await _sole_entitlement(db_session)
    assert entitlement.user_id == user_id
    assert entitlement.revoked_at is not None
    sale = await _reload_sale(db_session, SALE_ID)
    assert sale.refunded is False
    assert sale.revocation_processed_at is not None
    assert await _refund_audits(db_session) == []


@pytest.mark.asyncio
async def test_replayed_cancellation_revokes_exactly_once(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A redelivered cancellation keeps one revoked entitlement, timestamp unchanged."""
    await _persist_user(db_session)
    await _ping(async_client, _sale_payload())

    first = await _ping(async_client, _cancellation_payload())
    revoked_at = (await _sole_entitlement(db_session)).revoked_at
    claimed_at = (await _reload_sale(db_session, SALE_ID)).revocation_processed_at
    second = await _ping(async_client, _cancellation_payload())

    assert [first.status_code, second.status_code] == [HTTPStatus.OK, HTTPStatus.OK]
    assert revoked_at is not None
    assert (await _sole_entitlement(db_session)).revoked_at == revoked_at
    assert (await _reload_sale(db_session, SALE_ID)).revocation_processed_at == claimed_at


@pytest.mark.asyncio
async def test_cancellation_for_an_unknown_sale_changes_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A cancellation naming a sale_id we never stored is logged and moves nothing."""
    caplog.set_level(logging.DEBUG)
    await _persist_user(db_session)
    await _ping(async_client, _sale_payload())

    response = await _ping(async_client, _cancellation_payload(sale_id=UNKNOWN_SALE_ID))

    assert response.status_code == HTTPStatus.OK
    assert (await _sole_entitlement(db_session)).revoked_at is None
    original = await _reload_sale(db_session, SALE_ID)
    assert original.revocation_processed_at is None
    assert await _count_sales(db_session) == EXPECTED_SALES_AFTER_ORPHAN_CANCELLATION
    assert _log_carries_marker(caplog, UNKNOWN_SALE_MARKER)


@pytest.mark.asyncio
async def test_a_cancellation_ping_row_never_satisfies_its_own_sale_lookup(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The row a cancellation ping creates for itself must not read as an original sale.

    An unseen sale_id makes the webhook persist the cancellation verbatim with
    ``resource_name="cancellation"``. A redelivery would then meet the row it
    just created, so a lookup that forgets ``resource_name == "sale"`` would
    revoke the buyer's unrelated live access.
    """
    caplog.set_level(logging.DEBUG)
    await _persist_user(db_session)
    await _ping(async_client, _sale_payload())
    orphan = _cancellation_payload(sale_id=UNKNOWN_SALE_ID)

    first = await _ping(async_client, orphan)
    second = await _ping(async_client, orphan)

    assert [first.status_code, second.status_code] == [HTTPStatus.OK, HTTPStatus.OK]
    assert (await _sole_entitlement(db_session)).revoked_at is None
    stored = await _reload_sale(db_session, UNKNOWN_SALE_ID)
    assert stored.resource_name == CANCELLATION_RESOURCE
    assert stored.revocation_processed_at is None
    assert _log_carries_marker(caplog, UNKNOWN_SALE_MARKER)


@pytest.mark.asyncio
async def test_cancellation_of_a_covered_purchase_keeps_access(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A second live APTITUDE purchase survives one of them being cancelled."""
    caplog.set_level(logging.DEBUG)
    await _persist_user(db_session)
    await _ping(async_client, _sale_payload())
    await _ping(
        async_client,
        _sale_payload(
            sale_id=SECOND_SALE_ID,
            product_id=SECOND_APTITUDE_PRODUCT_ID,
            email=MIXED_CASE_BUYER_EMAIL,
        ),
    )

    response = await _ping(async_client, _cancellation_payload())

    assert response.status_code == HTTPStatus.OK
    assert (await _sole_entitlement(db_session)).revoked_at is None
    cancelled_sale = await _reload_sale(db_session, SALE_ID)
    assert cancelled_sale.refunded is False
    assert cancelled_sale.revocation_processed_at is not None
    assert _log_carries_marker(caplog, COVERED_MARKER)


@pytest.mark.asyncio
async def test_cancellation_of_a_token_pack_sale_keeps_the_credits(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A pack cancellation is wholly inert, right down to leaving the claim unspent.

    Credits obviously survive an event that reversed no money, but the
    load-bearing assertion is ``revocation_processed_at is None``: consuming
    the shared claim here would disarm the refund that may follow.
    """
    caplog.set_level(logging.DEBUG)
    user_id = await _persist_user(db_session)
    await _ping(async_client, _pack_payload())

    response = await _ping(async_client, _pack_payload(resource_name=CANCELLATION_RESOURCE))

    assert response.status_code == HTTPStatus.OK
    assert await _offering_balance(db_session, user_id) == TOKEN_PACK_SIZE
    assert await _refund_audits(db_session) == []
    sale = await _reload_sale(db_session, PACK_SALE_ID)
    assert sale.refunded is False
    assert sale.revocation_processed_at is None
    assert _log_carries_marker(caplog, NOT_APPLICABLE_MARKER)


@pytest.mark.asyncio
async def test_refund_after_an_inert_pack_cancellation_still_claws_back(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A stray cancellation cannot shield a pack from a genuine later refund.

    Cancellations do not apply to one-time purchases, so the earlier ping
    consumed nothing. The refund therefore finds the claim untaken and
    reverses the whole pack — otherwise this ordering would hand the buyer
    their money back and let them keep every credit.
    """
    user_id = await _persist_user(db_session)
    await _ping(async_client, _pack_payload())
    await _ping(async_client, _pack_payload(resource_name=CANCELLATION_RESOURCE))

    response = await _ping(async_client, _pack_payload(resource_name=REFUND_RESOURCE))

    assert response.status_code == HTTPStatus.OK
    assert await _offering_balance(db_session, user_id) == 0
    audits = await _refund_audits(db_session)
    assert len(audits) == 1
    assert audits[0].user_id == user_id
    assert audits[0].delta == Decimal(-TOKEN_PACK_SIZE)
    sale = await _reload_sale(db_session, PACK_SALE_ID)
    assert sale.refunded is True
    assert sale.revocation_processed_at is not None


@pytest.mark.asyncio
async def test_refund_after_an_aptitude_cancellation_revokes_only_once(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """On the side the shared claim was built for, the second event is a no-op.

    A cancelled subscription that is later refunded must not produce a second
    revoke transition, and the late refund must not re-stamp the claim or flip
    ``refunded`` — the cancellation already spent it.
    """
    await _persist_user(db_session)
    await _ping(async_client, _sale_payload())
    await _ping(async_client, _cancellation_payload())
    revoked_at = (await _sole_entitlement(db_session)).revoked_at
    claimed_at = (await _reload_sale(db_session, SALE_ID)).revocation_processed_at

    response = await _ping(async_client, _sale_payload(resource_name=REFUND_RESOURCE))

    assert response.status_code == HTTPStatus.OK
    assert revoked_at is not None
    assert claimed_at is not None
    assert (await _sole_entitlement(db_session)).revoked_at == revoked_at
    sale = await _reload_sale(db_session, SALE_ID)
    assert sale.revocation_processed_at == claimed_at
    assert sale.refunded is False


@pytest.mark.asyncio
async def test_cancellation_after_refund_claws_back_nothing_further(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A cancellation trailing a refund leaves the single claw-back untouched."""
    user_id = await _persist_user(db_session)
    await _ping(async_client, _pack_payload())
    await _ping(async_client, _pack_payload(resource_name=REFUND_RESOURCE))
    claimed_at = (await _reload_sale(db_session, PACK_SALE_ID)).revocation_processed_at

    response = await _ping(async_client, _pack_payload(resource_name=CANCELLATION_RESOURCE))

    assert response.status_code == HTTPStatus.OK
    assert await _offering_balance(db_session, user_id) == 0
    assert len(await _refund_audits(db_session)) == 1
    sale = await _reload_sale(db_session, PACK_SALE_ID)
    assert sale.refunded is True
    assert sale.revocation_processed_at == claimed_at


@pytest.mark.asyncio
async def test_forged_cancellation_is_rejected_and_changes_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An unauthenticated cancellation is a 401 that leaves access alive."""
    await _persist_user(db_session)
    await _ping(async_client, _sale_payload())

    response = await _ping(async_client, _cancellation_payload(), secret=WRONG_WEBHOOK_SECRET)

    assert response.status_code == HTTPStatus.UNAUTHORIZED
    assert (await _sole_entitlement(db_session)).revoked_at is None
    sale = await _reload_sale(db_session, SALE_ID)
    assert sale.revocation_processed_at is None
