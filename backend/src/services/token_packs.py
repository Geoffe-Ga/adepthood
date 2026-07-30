"""Exactly-once crediting of Gumroad token-pack purchases.

A token pack is bought on Gumroad and paid for before Adepthood hears about
it, and Gumroad re-delivers any ping it believes went unacknowledged. The
buyer may also not have an account yet. Both realities point at the same
requirement: the credit must be idempotent per *sale*, not per delivery and
not per account, and it must survive the purchase arriving before the buyer.

The guard is ``GumroadSale.token_pack_credited_at``. Taking it is a single
conditional ``UPDATE ... WHERE token_pack_credited_at IS NULL``; only the
writer whose ``rowcount`` comes back 1 goes on to move any money, and the
claim, the balance, and the audit row all commit in one transaction.

Lives in ``services`` rather than ``domain`` because it owns that
transaction boundary: it commits, and it rolls back.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, cast

from sqlalchemy import CursorResult, func, update
from sqlmodel import col, select

from domain.entitlements import is_token_pack_product_id, token_pack_size
from models.gumroad_sale import SALE_RESOURCE_NAME, GumroadSale
from services.wallet import grant_purchase_credit

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from models.user import User

__all__ = ["claim_token_pack_sales", "credit_token_pack_sale"]


async def _take_credit_claim(session: AsyncSession, sale_id: str, user_id: int) -> bool:
    """Stamp the sale's claim columns, returning whether this caller won.

    Under READ COMMITTED two transactions issuing this UPDATE serialize on
    the row lock. The loser re-evaluates its WHERE against the new row
    version, sees ``token_pack_credited_at IS NOT NULL``, gets ``rowcount``
    0, and credits nothing. If the winner rolls back, the loser instead sees
    the pre-image and credits — so the credit can be delayed by a race but
    never lost, and never doubled. ``gumroad_sale_id`` is UNIQUE, so the
    predicate targets exactly one row.

    ``synchronize_session=False`` is load-bearing, not decoration: the sale
    may already sit in the session's identity map, and SQLAlchemy's
    Python-side WHERE evaluator would then compare a timezone-naive stored
    value against an aware one and raise on SQLite. Issuing the UPDATE
    through SQL alone is exactly what the guard already guarantees.
    """
    result = await session.execute(
        update(GumroadSale)
        .where(
            col(GumroadSale.gumroad_sale_id) == sale_id,
            col(GumroadSale.token_pack_credited_at).is_(None),
        )
        .values(
            token_pack_credited_at=datetime.now(UTC),
            token_pack_credited_user_id=user_id,
        )
        .execution_options(synchronize_session=False)
    )
    return bool(cast("CursorResult[Any]", result).rowcount)


async def credit_token_pack_sale(
    session: AsyncSession,
    *,
    sale_id: str,
    user_id: int,
    amount: int,
) -> int | None:
    """Credit ``amount`` for ``sale_id`` exactly once; return the new balance.

    Returns ``None`` without touching the wallet when the claim cannot be
    taken — the sale was already credited, or no such sale is stored.

    A vanished buyer (the grant returns ``None``) rolls the claim back rather
    than leaving a sale marked as credited to nobody, so a later replay or
    signup sweep can still deliver the credits the buyer paid for.

    Commits on success: the claim, the balance, and the audit row are one
    transaction, so no crash can leave the sale claimed but unpaid.
    """
    if not await _take_credit_claim(session, sale_id, user_id):
        return None
    new_balance = await grant_purchase_credit(session, user_id, amount)
    if new_balance is None:
        await session.rollback()
        return None
    await session.commit()
    return new_balance


async def _unclaimed_token_pack_sales(
    session: AsyncSession,
    email: str,
) -> list[tuple[str, str]]:
    """Return ``(sale_id, product_id)`` for every sale still awaiting a credit.

    Filters in SQL to the rows a credit could ever apply to: purchase events
    only, not refunded, not already claimed, and belonging to ``email``
    case-insensitively (Gumroad reports the buyer's address as they typed
    it). Product classification stays in Python because both allowlists are
    environment configuration, not columns.

    Returns plain tuples rather than ORM rows on purpose: the caller commits
    between iterations, which would expire attached instances and turn the
    next attribute read into a lazy load outside the async context.
    """
    result = await session.execute(
        select(GumroadSale.gumroad_sale_id, GumroadSale.product_id).where(
            func.lower(GumroadSale.email) == email,
            col(GumroadSale.token_pack_credited_at).is_(None),
            col(GumroadSale.refunded).is_(False),
            col(GumroadSale.resource_name) == SALE_RESOURCE_NAME,
        )
    )
    return [(row.gumroad_sale_id, row.product_id) for row in result.all()]


async def claim_token_pack_sales(session: AsyncSession, user: User) -> None:
    """Sweep every token pack bought before ``user`` had an account into their wallet.

    Called once at signup. Each waiting sale is credited through the same
    exactly-once claim the webhook uses, so a pack that the webhook already
    credited (the buyer registered first) is skipped, and a pack swept here
    is skipped by any later webhook replay.

    ``user.id`` and ``user.email`` are snapshotted before the first credit
    because crediting commits this session, which expires the passed
    instance; re-reading an attribute afterwards would trigger a lazy load
    outside the greenlet rather than a fresh value.
    """
    user_id = user.id
    email = user.email.strip().lower()
    if user_id is None:
        return
    for sale_id, product_id in await _unclaimed_token_pack_sales(session, email):
        # An allowlisted product with no configured size credits nothing:
        # there is no safe default amount for real money.
        amount = token_pack_size(product_id) if is_token_pack_product_id(product_id) else None
        if amount is not None:
            await credit_token_pack_sale(session, sale_id=sale_id, user_id=user_id, amount=amount)
