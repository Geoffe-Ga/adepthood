"""Unit tests for :mod:`services.token_packs` - exactly-once token-pack credit.

Contract: taking a sale's claim and crediting the buyer's ``offering_balance``
happen in one transaction guarded by ``token_pack_credited_at``. A second
attempt on the same sale credits nothing; a grant against a vanished user
rolls the claim back so the sale stays available for a later retry. The
signup-time sweep claims every unclaimed, non-refunded, allowlisted, sized
sale ping matching the account's email case-insensitively.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.entitlements import TOKEN_PACK_PRODUCT_IDS_ENV_VAR, TOKEN_PACK_SIZES_ENV_VAR
from models.gumroad_sale import SALE_RESOURCE_NAME, GumroadSale
from models.user import User
from models.wallet_audit import REASON_GUMROAD_PURCHASE, WalletAudit
from services.token_packs import claim_token_pack_sales, credit_token_pack_sale

BUYER_EMAIL = "buyer@example.com"
MIXED_CASE_BUYER_EMAIL = "Buyer@Example.COM"
OTHER_EMAIL = "someone-else@example.com"
PACK_PRODUCT_ID = "prod_pack_small"
SECOND_PACK_PRODUCT_ID = "prod_pack_large"
UNSIZED_PACK_PRODUCT_ID = "prod_pack_unsized"
OFF_ALLOWLIST_PRODUCT_ID = "prod_course"
PACK_SIZE = 100
SECOND_PACK_SIZE = 250
SALE_ID = "S-900"
SECOND_SALE_ID = "S-901"
REFUND_RESOURCE_NAME = "refund"
MISSING_USER_ID = 999
PREEXISTING_BALANCE = 7
ALREADY_CLAIMED_AT = "2026-01-01T00:00:00+00:00"


@pytest.fixture(autouse=True)
def token_pack_config(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure both token-pack env vars for every test in this module."""
    monkeypatch.setenv(
        TOKEN_PACK_PRODUCT_IDS_ENV_VAR,
        f"{PACK_PRODUCT_ID},{SECOND_PACK_PRODUCT_ID},{UNSIZED_PACK_PRODUCT_ID}",
    )
    monkeypatch.setenv(
        TOKEN_PACK_SIZES_ENV_VAR,
        f"{PACK_PRODUCT_ID}:{PACK_SIZE},{SECOND_PACK_PRODUCT_ID}:{SECOND_PACK_SIZE}",
    )


async def _make_user(
    session: AsyncSession,
    *,
    email: str = BUYER_EMAIL,
    offering_balance: int = 0,
) -> tuple[User, int]:
    """Create and commit a buyer; return the row plus its non-null id.

    The id is returned separately because the services under test commit and
    roll back the same session, which expires the ORM instance -- reading
    ``user_id`` afterwards would trigger a lazy load outside the async
    context rather than an assertion failure.
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
    and lets the ineligible-row cases be parametrized as whole records.
    """

    sale_id: str = SALE_ID
    product_id: str = PACK_PRODUCT_ID
    email: str = BUYER_EMAIL
    resource_name: str = SALE_RESOURCE_NAME
    refunded: bool = False
    claimed: bool = False


_ELIGIBLE_SALE = _SaleShape()


async def _make_sale(session: AsyncSession, shape: _SaleShape = _ELIGIBLE_SALE) -> GumroadSale:
    """Create and commit one Gumroad ping row, optionally pre-claimed."""
    sale = GumroadSale(
        gumroad_sale_id=shape.sale_id,
        product_id=shape.product_id,
        email=shape.email,
        resource_name=shape.resource_name,
        refunded=shape.refunded,
        raw_payload={"sale_id": shape.sale_id},
    )
    if shape.claimed:
        sale.token_pack_credited_at = datetime.fromisoformat(ALREADY_CLAIMED_AT)
    session.add(sale)
    await session.commit()
    await session.refresh(sale)
    return sale


async def _reload_sale(session: AsyncSession, sale_id: str) -> GumroadSale:
    """Re-read a sale row from the database, bypassing the identity map."""
    result = await session.execute(
        select(GumroadSale)
        .where(GumroadSale.gumroad_sale_id == sale_id)
        .execution_options(populate_existing=True)
    )
    return result.scalars().one()


async def _balance(session: AsyncSession, user_id: int) -> int:
    """Return the user's persisted ``offering_balance``, read fresh."""
    result = await session.execute(
        select(User).where(User.id == user_id).execution_options(populate_existing=True)
    )
    return int(result.scalars().one().offering_balance)


async def _purchase_audits(session: AsyncSession, user_id: int) -> list[WalletAudit]:
    """Return only the ``gumroad_purchase`` audit rows for ``user_id``."""
    result = await session.execute(
        select(WalletAudit)
        .where(
            col(WalletAudit.user_id) == user_id,
            col(WalletAudit.reason) == REASON_GUMROAD_PURCHASE,
        )
        .order_by(col(WalletAudit.id))
    )
    return list(result.scalars().all())


@pytest.mark.asyncio
async def test_credit_token_pack_sale_credits_and_stamps_the_claim(
    db_session: AsyncSession,
) -> None:
    """A first credit adds the pack, stamps both claim columns, and audits once."""
    _user, user_id = await _make_user(db_session, offering_balance=PREEXISTING_BALANCE)
    await _make_sale(db_session)

    new_balance = await credit_token_pack_sale(
        db_session, sale_id=SALE_ID, user_id=user_id, amount=PACK_SIZE
    )

    assert new_balance == PREEXISTING_BALANCE + PACK_SIZE
    assert await _balance(db_session, user_id) == PREEXISTING_BALANCE + PACK_SIZE
    sale = await _reload_sale(db_session, SALE_ID)
    assert sale.token_pack_credited_at is not None
    assert sale.token_pack_credited_user_id == user_id
    assert len(await _purchase_audits(db_session, user_id)) == 1


@pytest.mark.asyncio
async def test_credit_token_pack_sale_is_exactly_once_per_sale(
    db_session: AsyncSession,
) -> None:
    """A second credit for the same sale returns None and moves no credits."""
    _user, user_id = await _make_user(db_session)
    await _make_sale(db_session)

    first = await credit_token_pack_sale(
        db_session, sale_id=SALE_ID, user_id=user_id, amount=PACK_SIZE
    )
    second = await credit_token_pack_sale(
        db_session, sale_id=SALE_ID, user_id=user_id, amount=PACK_SIZE
    )

    assert first == PACK_SIZE
    assert second is None
    assert await _balance(db_session, user_id) == PACK_SIZE
    assert len(await _purchase_audits(db_session, user_id)) == 1


@pytest.mark.asyncio
async def test_credit_token_pack_sale_missing_user_leaves_sale_unclaimed(
    db_session: AsyncSession,
) -> None:
    """A vanished buyer rolls the claim back so the sale stays creditable later."""
    await _make_sale(db_session)

    result = await credit_token_pack_sale(
        db_session, sale_id=SALE_ID, user_id=MISSING_USER_ID, amount=PACK_SIZE
    )

    assert result is None
    sale = await _reload_sale(db_session, SALE_ID)
    assert sale.token_pack_credited_at is None
    assert sale.token_pack_credited_user_id is None
    assert await _purchase_audits(db_session, MISSING_USER_ID) == []


@pytest.mark.asyncio
async def test_credit_token_pack_sale_unknown_sale_id_credits_nothing(
    db_session: AsyncSession,
) -> None:
    """A sale_id with no stored row cannot be claimed, so no wallet moves."""
    _user, user_id = await _make_user(db_session)

    result = await credit_token_pack_sale(
        db_session, sale_id=SALE_ID, user_id=user_id, amount=PACK_SIZE
    )

    assert result is None
    assert await _balance(db_session, user_id) == 0
    assert await _purchase_audits(db_session, user_id) == []


@pytest.mark.asyncio
async def test_claim_token_pack_sales_credits_every_unclaimed_pack(
    db_session: AsyncSession,
) -> None:
    """Two waiting packs sum into the balance and each stamps its own claim."""
    user, user_id = await _make_user(db_session)
    await _make_sale(db_session, _SaleShape(sale_id=SALE_ID, product_id=PACK_PRODUCT_ID))
    await _make_sale(
        db_session, _SaleShape(sale_id=SECOND_SALE_ID, product_id=SECOND_PACK_PRODUCT_ID)
    )

    await claim_token_pack_sales(db_session, user)

    assert await _balance(db_session, user_id) == PACK_SIZE + SECOND_PACK_SIZE
    assert len(await _purchase_audits(db_session, user_id)) == 2
    for sale_id in (SALE_ID, SECOND_SALE_ID):
        sale = await _reload_sale(db_session, sale_id)
        assert sale.token_pack_credited_at is not None
        assert sale.token_pack_credited_user_id == user_id


@pytest.mark.asyncio
async def test_claim_token_pack_sales_matches_email_case_insensitively(
    db_session: AsyncSession,
) -> None:
    """A pack bought under a mixed-case email still reaches the lowercase account."""
    user, user_id = await _make_user(db_session)
    await _make_sale(db_session, _SaleShape(email=MIXED_CASE_BUYER_EMAIL))

    await claim_token_pack_sales(db_session, user)

    assert await _balance(db_session, user_id) == PACK_SIZE
    assert len(await _purchase_audits(db_session, user_id)) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "shape",
    [
        _SaleShape(refunded=True),
        _SaleShape(resource_name=REFUND_RESOURCE_NAME),
        _SaleShape(product_id=OFF_ALLOWLIST_PRODUCT_ID),
        _SaleShape(product_id=UNSIZED_PACK_PRODUCT_ID),
        _SaleShape(claimed=True),
        _SaleShape(email=OTHER_EMAIL),
    ],
    ids=[
        "refunded",
        "non_sale_resource",
        "off_allowlist",
        "unsized_product",
        "already_claimed",
        "other_buyer",
    ],
)
async def test_claim_token_pack_sales_skips_ineligible_rows(
    db_session: AsyncSession,
    shape: _SaleShape,
) -> None:
    """Every ineligible sale shape leaves the wallet at zero with no audit row."""
    user, user_id = await _make_user(db_session)
    await _make_sale(db_session, shape)

    await claim_token_pack_sales(db_session, user)

    assert await _balance(db_session, user_id) == 0
    assert await _purchase_audits(db_session, user_id) == []


@pytest.mark.asyncio
async def test_claim_token_pack_sales_with_empty_allowlist_is_a_no_op(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unconfigured allowlist fails closed: a waiting pack credits nothing."""
    monkeypatch.delenv(TOKEN_PACK_PRODUCT_IDS_ENV_VAR, raising=False)
    user, user_id = await _make_user(db_session)
    await _make_sale(db_session)

    await claim_token_pack_sales(db_session, user)

    assert await _balance(db_session, user_id) == 0
    sale = await _reload_sale(db_session, SALE_ID)
    assert sale.token_pack_credited_at is None


@pytest.mark.asyncio
async def test_claim_token_pack_sales_without_any_sale_is_a_no_op(
    db_session: AsyncSession,
) -> None:
    """A buyer with no waiting packs finishes the sweep with an untouched wallet."""
    user, user_id = await _make_user(db_session)

    await claim_token_pack_sales(db_session, user)

    assert await _balance(db_session, user_id) == 0
    assert await _purchase_audits(db_session, user_id) == []
