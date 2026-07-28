"""Unit tests for :mod:`services.gumroad_revocation` — the reversal edge branches.

Driven directly against a session so the states the webhook cannot easily
stage are reachable: a pack refunded before anyone claimed it, a pack whose
product lost its configured size, and a claimed pack whose crediting account
has since been deleted. Each of those must still stamp the shared
``revocation_processed_at`` claim, write nothing to the wallet, and say why in
a structured log line.

Also pins the lookup contract both handlers share: the sale is resolved from
the STORED purchase row (``resource_name == "sale"``), so the row the webhook
persists for an orphan refund or cancellation ping can never stand in for the
purchase it claims to reverse.

The two handlers are deliberately asymmetric about product class.
``process_refund`` reverses whatever the stored sale delivered and claims
every sale it resolves. ``process_cancellation`` acts only on an APTITUDE
product — nothing else is a subscription — and is inert for anything else,
taking no claim so the refund path stays armed.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.entitlements import (
    PRODUCT_IDS_ENV_VAR,
    TOKEN_PACK_PRODUCT_IDS_ENV_VAR,
    TOKEN_PACK_SIZES_ENV_VAR,
)
from models.gumroad_sale import SALE_RESOURCE_NAME, GumroadSale
from models.user import User
from models.wallet_audit import REASON_GUMROAD_PURCHASE, REASON_GUMROAD_REFUND, WalletAudit
from services.gumroad_revocation import process_cancellation, process_refund
from services.token_packs import claim_token_pack_sales

APTITUDE_PRODUCT_ID = "prod_course_abc"
PACK_PRODUCT_ID = "prod_pack_small"
UNSIZED_PACK_PRODUCT_ID = "prod_pack_unsized"
UNKNOWN_PRODUCT_ID = "prod_not_sold_here"
PACK_SIZE = 100

BUYER_EMAIL = "buyer@example.com"
SALE_ID = "S-900"
SEEDED_BALANCE = 42
CREDITED_AT = "2026-01-01T00:00:00+00:00"

REFUND_RESOURCE = "refund"
CANCELLATION_RESOURCE = "cancellation"

UNKNOWN_SALE_MARKER = "unknown_sale"
UNCONFIGURED_SIZE_MARKER = "token_pack_size_unconfigured"
CREDITED_USER_MISSING_MARKER = "credited_user_missing"
NOT_APPLICABLE_MARKER = "cancellation_not_applicable"


@pytest.fixture(autouse=True)
def gumroad_config(monkeypatch: pytest.MonkeyPatch) -> None:
    """Allowlist both product families and size only the sellable pack."""
    monkeypatch.setenv(PRODUCT_IDS_ENV_VAR, APTITUDE_PRODUCT_ID)
    monkeypatch.setenv(
        TOKEN_PACK_PRODUCT_IDS_ENV_VAR, f"{PACK_PRODUCT_ID},{UNSIZED_PACK_PRODUCT_ID}"
    )
    monkeypatch.setenv(TOKEN_PACK_SIZES_ENV_VAR, f"{PACK_PRODUCT_ID}:{PACK_SIZE}")


def _payload(sale_id: str = SALE_ID) -> dict[str, str]:
    """Build the minimal ping payload a revocation handler consumes.

    Deliberately carries nothing but the idempotency key: every other fact
    the handlers act on has to come from the stored sale row.
    """
    return {"sale_id": sale_id}


def _log_carries_marker(caplog: pytest.LogCaptureFixture, marker: str) -> bool:
    """Return True when ``marker`` appears in captured text or as a reason_code."""
    if marker in caplog.text:
        return True
    return any(getattr(record, "reason_code", None) == marker for record in caplog.records)


async def _make_user(
    session: AsyncSession,
    *,
    email: str = BUYER_EMAIL,
    offering_balance: int = 0,
) -> tuple[User, int]:
    """Create and commit a buyer; return the row plus its non-null id.

    The id comes back separately because the services under test commit the
    same session, so a later attribute read off the instance would lazy-load
    outside the async context rather than fail an assertion.
    """
    user = User(
        email=email,
        password_hash="x",  # pragma: allowlist secret
        offering_balance=offering_balance,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    if user.id is None:
        msg = "user id missing after commit"
        raise RuntimeError(msg)
    return user, user.id


@dataclass(frozen=True)
class _SaleShape:
    """The variable fields of one seeded Gumroad ping row.

    Bundling them keeps the seeding helper under ruff's argument-count cap
    and lets each edge state be expressed as a whole record.
    """

    sale_id: str = SALE_ID
    product_id: str = PACK_PRODUCT_ID
    email: str = BUYER_EMAIL
    resource_name: str = SALE_RESOURCE_NAME
    refunded: bool = False
    credited: bool = False
    credited_user_id: int | None = None


async def _make_sale(session: AsyncSession, shape: _SaleShape) -> None:
    """Create and commit one Gumroad ping row in the requested state."""
    sale = GumroadSale(
        gumroad_sale_id=shape.sale_id,
        product_id=shape.product_id,
        email=shape.email,
        resource_name=shape.resource_name,
        refunded=shape.refunded,
        raw_payload={"sale_id": shape.sale_id},
    )
    if shape.credited:
        sale.token_pack_credited_at = datetime.fromisoformat(CREDITED_AT)
        sale.token_pack_credited_user_id = shape.credited_user_id
    session.add(sale)
    await session.commit()


async def _reload_sale(session: AsyncSession, sale_id: str = SALE_ID) -> GumroadSale:
    """Re-read one sale row from the database, bypassing the identity map."""
    result = await session.execute(
        select(GumroadSale)
        .where(col(GumroadSale.gumroad_sale_id) == sale_id)
        .execution_options(populate_existing=True)
    )
    return result.scalars().one()


async def _balance(session: AsyncSession, user_id: int) -> int:
    """Return the user's persisted offering balance, read fresh."""
    result = await session.execute(
        select(User).where(col(User.id) == user_id).execution_options(populate_existing=True)
    )
    return int(result.scalars().one().offering_balance)


async def _audits(session: AsyncSession, reason: str) -> list[WalletAudit]:
    """Return every wallet-audit row carrying ``reason``, oldest first."""
    result = await session.execute(
        select(WalletAudit)
        .where(col(WalletAudit.reason) == reason)
        .order_by(col(WalletAudit.id))
        .execution_options(populate_existing=True)
    )
    return list(result.scalars().all())


@pytest.mark.asyncio
async def test_refund_of_an_uncredited_pack_stamps_the_claim_only(
    db_session: AsyncSession,
) -> None:
    """A pack refunded before anyone claimed it marks the sale and moves no money."""
    _user, user_id = await _make_user(db_session)
    await _make_sale(db_session, _SaleShape())

    await process_refund(db_session, _payload())

    assert await _balance(db_session, user_id) == 0
    assert await _audits(db_session, REASON_GUMROAD_REFUND) == []
    sale = await _reload_sale(db_session)
    assert sale.refunded is True
    assert sale.revocation_processed_at is not None


@pytest.mark.asyncio
async def test_a_refunded_uncredited_pack_is_skipped_by_the_signup_sweep(
    db_session: AsyncSession,
) -> None:
    """Stamping ``refunded`` is what stops the signup sweep paying out later.

    The buyer refunds before registering, then signs up: the sweep filters on
    ``refunded IS False``, so the pack they no longer paid for must not land
    in the new account's wallet.
    """
    user, user_id = await _make_user(db_session)
    await _make_sale(db_session, _SaleShape())
    await process_refund(db_session, _payload())

    await claim_token_pack_sales(db_session, user)

    assert await _balance(db_session, user_id) == 0
    assert await _audits(db_session, REASON_GUMROAD_PURCHASE) == []
    assert (await _reload_sale(db_session)).token_pack_credited_at is None


@pytest.mark.asyncio
async def test_refund_of_a_pack_with_no_configured_size_stamps_the_claim_only(
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An allowlisted pack that lost its price fails closed instead of guessing.

    There is no safe default claw-back amount for real money, so the claim is
    taken (nothing will retry it blindly) and the reason is logged for an
    operator to reconcile by hand.
    """
    caplog.set_level(logging.DEBUG)
    _user, user_id = await _make_user(db_session, offering_balance=SEEDED_BALANCE)
    await _make_sale(
        db_session,
        _SaleShape(product_id=UNSIZED_PACK_PRODUCT_ID, credited=True, credited_user_id=user_id),
    )

    await process_refund(db_session, _payload())

    assert await _balance(db_session, user_id) == SEEDED_BALANCE
    assert await _audits(db_session, REASON_GUMROAD_REFUND) == []
    sale = await _reload_sale(db_session)
    assert sale.refunded is True
    assert sale.revocation_processed_at is not None
    assert _log_carries_marker(caplog, UNCONFIGURED_SIZE_MARKER)


@pytest.mark.asyncio
async def test_refund_of_a_pack_whose_credited_account_vanished_stamps_the_claim_only(
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A credited sale with no recipient left cannot be debited, only recorded.

    ``token_pack_credited_user_id`` is ``SET NULL`` on account deletion, so a
    claimed sale can outlive the wallet it paid into. The refund must not
    crash and must not invent a victim.
    """
    caplog.set_level(logging.DEBUG)
    _user, user_id = await _make_user(db_session, offering_balance=SEEDED_BALANCE)
    await _make_sale(db_session, _SaleShape(credited=True))

    await process_refund(db_session, _payload())

    assert await _balance(db_session, user_id) == SEEDED_BALANCE
    assert await _audits(db_session, REASON_GUMROAD_REFUND) == []
    sale = await _reload_sale(db_session)
    assert sale.refunded is True
    assert sale.revocation_processed_at is not None
    assert _log_carries_marker(caplog, CREDITED_USER_MISSING_MARKER)


@pytest.mark.asyncio
async def test_refund_of_a_sale_on_neither_allowlist_stamps_the_claim_only(
    db_session: AsyncSession,
) -> None:
    """An unrecognised product reverses nothing, but is still claimed once."""
    _user, user_id = await _make_user(db_session, offering_balance=SEEDED_BALANCE)
    await _make_sale(
        db_session,
        _SaleShape(product_id=UNKNOWN_PRODUCT_ID, credited=True, credited_user_id=user_id),
    )

    await process_refund(db_session, _payload())

    assert await _balance(db_session, user_id) == SEEDED_BALANCE
    assert await _audits(db_session, REASON_GUMROAD_REFUND) == []
    assert (await _reload_sale(db_session)).revocation_processed_at is not None


@pytest.mark.asyncio
async def test_cancellation_of_a_credited_pack_keeps_the_credits(
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A one-time purchase cannot be cancelled, so the handler declines it outright.

    Declining has to mean taking no claim, not merely moving no money: a
    stamped ``revocation_processed_at`` here would silently disarm the refund
    handler and let a refunded buyer keep the pack.
    """
    caplog.set_level(logging.DEBUG)
    _user, user_id = await _make_user(db_session, offering_balance=PACK_SIZE)
    await _make_sale(db_session, _SaleShape(credited=True, credited_user_id=user_id))

    await process_cancellation(db_session, _payload())

    assert await _balance(db_session, user_id) == PACK_SIZE
    assert await _audits(db_session, REASON_GUMROAD_REFUND) == []
    sale = await _reload_sale(db_session)
    assert sale.refunded is False
    assert sale.revocation_processed_at is None
    assert _log_carries_marker(caplog, NOT_APPLICABLE_MARKER)


@pytest.mark.asyncio
async def test_cancellation_of_a_sale_on_neither_allowlist_is_inert(
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An unrecognised product is not a subscription either, so nothing is claimed.

    The refund twin of this case still stamps the claim; only cancellation
    narrows to APTITUDE, and it must fail closed for products it does not
    recognise rather than defaulting to "cancel it".
    """
    caplog.set_level(logging.DEBUG)
    _user, user_id = await _make_user(db_session, offering_balance=SEEDED_BALANCE)
    await _make_sale(
        db_session,
        _SaleShape(product_id=UNKNOWN_PRODUCT_ID, credited=True, credited_user_id=user_id),
    )

    await process_cancellation(db_session, _payload())

    assert await _balance(db_session, user_id) == SEEDED_BALANCE
    assert await _audits(db_session, REASON_GUMROAD_REFUND) == []
    sale = await _reload_sale(db_session)
    assert sale.refunded is False
    assert sale.revocation_processed_at is None
    assert _log_carries_marker(caplog, NOT_APPLICABLE_MARKER)


@pytest.mark.asyncio
async def test_cancellation_after_a_pack_refund_takes_no_second_claim(
    db_session: AsyncSession,
) -> None:
    """A trailing cancellation leaves a refunded pack exactly as the refund left it.

    Two reasons converge here and both must hold: the refund already spent the
    shared claim, and a pack is not cancellable in the first place. Either way
    the timestamp, the balance, and the audit count are frozen.
    """
    _user, user_id = await _make_user(db_session, offering_balance=PACK_SIZE)
    await _make_sale(db_session, _SaleShape(credited=True, credited_user_id=user_id))

    await process_refund(db_session, _payload())
    claimed_at = (await _reload_sale(db_session)).revocation_processed_at
    await process_cancellation(db_session, _payload())

    assert claimed_at is not None
    assert (await _reload_sale(db_session)).revocation_processed_at == claimed_at
    assert await _balance(db_session, user_id) == 0
    assert len(await _audits(db_session, REASON_GUMROAD_REFUND)) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("resource_name", [REFUND_RESOURCE, CANCELLATION_RESOURCE])
async def test_process_refund_ignores_a_row_that_is_not_a_purchase(
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
    resource_name: str,
) -> None:
    """Only a ``sale`` row can be reversed; a stored event row is not a purchase."""
    caplog.set_level(logging.DEBUG)
    _user, user_id = await _make_user(db_session, offering_balance=PACK_SIZE)
    await _make_sale(
        db_session,
        _SaleShape(resource_name=resource_name, credited=True, credited_user_id=user_id),
    )

    await process_refund(db_session, _payload())

    sale = await _reload_sale(db_session)
    assert sale.refunded is False
    assert sale.revocation_processed_at is None
    assert await _balance(db_session, user_id) == PACK_SIZE
    assert await _audits(db_session, REASON_GUMROAD_REFUND) == []
    assert _log_carries_marker(caplog, UNKNOWN_SALE_MARKER)


@pytest.mark.asyncio
@pytest.mark.parametrize("resource_name", [REFUND_RESOURCE, CANCELLATION_RESOURCE])
async def test_process_cancellation_ignores_a_row_that_is_not_a_purchase(
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
    resource_name: str,
) -> None:
    """The cancellation handler shares the purchase-only lookup with the refund one."""
    caplog.set_level(logging.DEBUG)
    await _make_sale(db_session, _SaleShape(resource_name=resource_name))

    await process_cancellation(db_session, _payload())

    assert (await _reload_sale(db_session)).revocation_processed_at is None
    assert _log_carries_marker(caplog, UNKNOWN_SALE_MARKER)


@pytest.mark.asyncio
async def test_process_refund_with_no_stored_sale_is_a_no_op(
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A refund for a sale_id that was never stored writes nothing at all."""
    caplog.set_level(logging.DEBUG)
    _user, user_id = await _make_user(db_session, offering_balance=PACK_SIZE)

    await process_refund(db_session, _payload())

    assert await _balance(db_session, user_id) == PACK_SIZE
    assert await _audits(db_session, REASON_GUMROAD_REFUND) == []
    assert _log_carries_marker(caplog, UNKNOWN_SALE_MARKER)


@pytest.mark.asyncio
async def test_process_cancellation_with_no_stored_sale_is_a_no_op(
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A cancellation for a sale_id that was never stored writes nothing at all."""
    caplog.set_level(logging.DEBUG)
    _user, user_id = await _make_user(db_session, offering_balance=PACK_SIZE)

    await process_cancellation(db_session, _payload())

    assert await _balance(db_session, user_id) == PACK_SIZE
    assert await _audits(db_session, REASON_GUMROAD_REFUND) == []
    assert _log_carries_marker(caplog, UNKNOWN_SALE_MARKER)
