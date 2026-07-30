"""Exactly-once reversal of a Gumroad purchase.

Gumroad reports every way a sale can come undone as its own ping: ``refund``
and ``dispute`` return the money, ``cancellation`` and ``subscription_ended``
merely stop the renewals. All four are re-delivered until acknowledged, and
the same purchase can legitimately attract more than one of them, so the
reversal has to be idempotent per *sale* rather than per delivery.

The guard is ``GumroadSale.revocation_processed_at``, taken with a single
conditional ``UPDATE ... WHERE revocation_processed_at IS NULL``. Only the
writer whose ``rowcount`` comes back 1 reverses anything; every later event
finds the claim spent and does nothing. One shared column across all four
event types is deliberate — a subscription that is cancelled and then
refunded must lose its access once, not twice.

Two rules keep the reversal honest:

* **Nothing but the idempotency key comes from the payload.** The product,
  the buyer, the pack size, and the account that actually received the
  credits are all read off the stored purchase row, so a forged ping cannot
  redirect a claw-back or aim a revocation at somebody else's account.
* **The purchase is resolved as a purchase.** An orphan reversal ping is
  itself persisted verbatim by the webhook, so the lookup requires
  ``resource_name == "sale"`` or a redelivery would find the row it just
  created and "reverse" it.

The two handlers are asymmetric about product class on purpose.
``process_refund`` reverses whatever the sale delivered and claims every sale
it resolves. ``process_cancellation`` acts only on an APTITUDE sale — a
one-time token pack is not a subscription — and is otherwise wholly inert,
taking no claim, because consuming the shared guard there would permanently
disarm the refund that may follow and hand the buyer both their money and
their credits.

Lives in ``services`` rather than ``domain`` because it owns the transaction
boundary: it commits.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, cast

from sqlalchemy import CursorResult, func, update
from sqlmodel import col, select

from domain.entitlements import (
    REASON_CANCELLATION,
    REASON_REFUND,
    is_aptitude_product_id,
    is_token_pack_product_id,
    revoke_course_access,
    token_pack_size,
)
from models.gumroad_sale import SALE_RESOURCE_NAME, GumroadSale
from models.user import User
from services.wallet import claw_back_purchase_credit

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

__all__ = ["process_cancellation", "process_refund"]

logger = logging.getLogger(__name__)

# Structured-log reason codes for the outcomes an operator needs to grep for.
# Every one of them marks a reversal ping that was accepted and answered 200
# but deliberately moved less than a naive reading would expect.
_REASON_UNKNOWN_SALE = "unknown_sale"
_REASON_UNKNOWN_PRODUCT = "unknown_product"
_REASON_COVERED = "covered_by_other_sale"
_REASON_NOT_APPLICABLE = "cancellation_not_applicable"
_REASON_BUYER_NOT_REGISTERED = "buyer_not_registered"
_REASON_NEVER_CREDITED = "token_pack_never_credited"
_REASON_CREDITED_USER_MISSING = "credited_user_missing"
# Same spelling the sale-dispatch path already uses for a priced-out pack, so
# both halves of the money story group under one reason code.
_REASON_SIZE_UNCONFIGURED = "token_pack_size_unconfigured"
_REASON_CLAWED_BACK = "token_pack_clawed_back"

# One event name for every declined reversal so a log query can start from
# the marker and narrow by reason_code, matching the router's convention.
_SKIPPED_EVENT = "gumroad_reversal_skipped"


@dataclass(frozen=True)
class _StoredSale:
    """The stored purchase facts a reversal is allowed to act on.

    Snapshotted into a plain record the moment the sale is resolved, before
    anything commits. Reading these off an attached ORM instance instead
    would turn every post-commit access into a lazy load outside the async
    context, and would invite the payload's own fields to creep back in.
    """

    sale_id: str
    product_id: str
    email: str
    token_pack_credited_at: datetime | None
    token_pack_credited_user_id: int | None


async def _resolve_stored_sale(
    session: AsyncSession, payload: dict[str, str]
) -> _StoredSale | None:
    """Resolve the original purchase this reversal names, or ``None``.

    The ``resource_name == "sale"`` filter is load-bearing rather than
    cosmetic: an unrecognised ``sale_id`` makes the webhook persist the
    reversal ping itself as a row under the same key, and without the filter
    a redelivery of that ping would resolve the row it just created.
    """
    sale_id = payload["sale_id"]
    result = await session.execute(
        select(
            GumroadSale.product_id,
            GumroadSale.email,
            GumroadSale.token_pack_credited_at,
            GumroadSale.token_pack_credited_user_id,
        ).where(
            col(GumroadSale.gumroad_sale_id) == sale_id,
            col(GumroadSale.resource_name) == SALE_RESOURCE_NAME,
        )
    )
    row = result.first()
    if row is None:
        logger.info(_SKIPPED_EVENT, extra={"reason_code": _REASON_UNKNOWN_SALE})
        return None
    return _StoredSale(
        sale_id=sale_id,
        product_id=row.product_id,
        email=row.email,
        token_pack_credited_at=row.token_pack_credited_at,
        token_pack_credited_user_id=row.token_pack_credited_user_id,
    )


async def _take_revocation_claim(
    session: AsyncSession,
    sale_id: str,
    *,
    mark_refunded: bool,
) -> bool:
    """Stamp the sale's reversal claim, returning whether this caller won.

    Under READ COMMITTED two transactions issuing this UPDATE serialize on
    the row lock. The loser re-evaluates its WHERE against the new row
    version, sees ``revocation_processed_at IS NOT NULL``, gets ``rowcount``
    0, and reverses nothing. ``gumroad_sale_id`` is UNIQUE and the
    ``resource_name`` predicate is the same one that resolved the row, so
    the statement targets exactly the purchase being reversed.

    ``mark_refunded`` folds the money question into the same statement: a
    refund flips ``refunded`` alongside the claim (which is also what stops
    the signup sweep paying the pack out later), while a cancellation leaves
    it alone because the seller kept the payment.

    ``synchronize_session=False`` is load-bearing, not decoration: the sale
    may already sit in the session's identity map, and SQLAlchemy's
    Python-side WHERE evaluator would then compare a timezone-naive stored
    value against an aware one and raise on SQLite. Issuing the UPDATE
    through SQL alone is exactly what the guard already guarantees.
    """
    values: dict[str, Any] = {"revocation_processed_at": datetime.now(UTC)}
    if mark_refunded:
        values["refunded"] = True
    result = await session.execute(
        update(GumroadSale)
        .where(
            col(GumroadSale.gumroad_sale_id) == sale_id,
            col(GumroadSale.resource_name) == SALE_RESOURCE_NAME,
            col(GumroadSale.revocation_processed_at).is_(None),
        )
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    return bool(cast("CursorResult[Any]", result).rowcount)


async def _is_covered_by_another_sale(session: AsyncSession, stored: _StoredSale) -> bool:
    """Return True when another live APTITUDE purchase still earns this access.

    A buyer who owns the course twice and reverses one copy keeps their
    access — the entitlement belongs to the person, not to the receipt. A
    sale stops covering the moment it is itself refunded *or* claimed by any
    reversal, which is why the predicate cannot lean on ``refunded`` alone: a
    cancellation stamps only the claim.

    Filters in SQL down to the rows a cover could ever come from and
    classifies the product in Python, the same split
    :func:`services.token_packs._unclaimed_token_pack_sales` uses, because
    both allowlists are environment configuration rather than columns. The
    email predicate folds case to ride ``ix_gumroadsale_lower_email``.
    """
    result = await session.execute(
        select(GumroadSale.product_id).where(
            col(GumroadSale.resource_name) == SALE_RESOURCE_NAME,
            col(GumroadSale.gumroad_sale_id) != stored.sale_id,
            func.lower(GumroadSale.email) == stored.email.strip().lower(),
            col(GumroadSale.refunded).is_(False),
            col(GumroadSale.revocation_processed_at).is_(None),
        )
    )
    return any(is_aptitude_product_id(row.product_id) for row in result.all())


async def _find_user_id_by_email(session: AsyncSession, email: str) -> int | None:
    """Return the id of the account registered under ``email``, or ``None``.

    Folds case exactly as the webhook's own lookup does: Gumroad reports the
    buyer's address as they typed it while accounts are stored normalized.
    Resolving the buyer here rather than in the router keeps the dependency
    pointing one way — routers import services, never the reverse.
    """
    normalized = email.strip().lower()
    if not normalized:
        return None
    result = await session.execute(select(User.id).where(func.lower(User.email) == normalized))
    return result.scalars().first()


async def _revoke_course_access_for(
    session: AsyncSession,
    stored: _StoredSale,
    reason: str,
) -> None:
    """Revoke the buyer's course access unless another purchase still covers it.

    A buyer who never registered is a clean no-op: the sale granted nothing
    at purchase time, so there is nothing to take back. The claim is still
    spent by the caller either way, which closes the sale out rather than
    leaving it armed for a redelivery to reverse an account that appears
    later.
    """
    if await _is_covered_by_another_sale(session, stored):
        logger.info(_SKIPPED_EVENT, extra={"reason_code": _REASON_COVERED})
        return
    user_id = await _find_user_id_by_email(session, stored.email)
    if user_id is None:
        logger.info(_SKIPPED_EVENT, extra={"reason_code": _REASON_BUYER_NOT_REGISTERED})
        return
    await revoke_course_access(session, user_id, reason)


def _claw_back_amount(stored: _StoredSale) -> int | None:
    """Return how many credits this refund must reclaim, or ``None`` for none.

    Two gates, each failing closed and each logged. A pack nobody ever
    claimed has no credits to take back (the buyer refunded before
    registering; stamping ``refunded`` is what stops the signup sweep paying
    it out). An allowlisted pack whose configured size has gone missing is
    reconciled by hand rather than guessed at — there is no safe default
    claw-back for real money.
    """
    if stored.token_pack_credited_at is None:
        logger.info(_SKIPPED_EVENT, extra={"reason_code": _REASON_NEVER_CREDITED})
        return None
    amount = token_pack_size(stored.product_id)
    if amount is None:
        logger.info(_SKIPPED_EVENT, extra={"reason_code": _REASON_SIZE_UNCONFIGURED})
    return amount


async def _debit_credited_account(
    session: AsyncSession,
    stored: _StoredSale,
    amount: int,
) -> None:
    """Take ``amount`` back out of the account that actually received the pack.

    ``token_pack_credited_user_id`` is ``SET NULL`` on account deletion, so a
    claimed sale can outlive the wallet it paid into; that case is recorded
    rather than redirected, because the alternative is inventing a victim
    from the payload's email.
    """
    user_id = stored.token_pack_credited_user_id
    new_balance = (
        None if user_id is None else await claw_back_purchase_credit(session, user_id, amount)
    )
    if new_balance is None:
        logger.info(_SKIPPED_EVENT, extra={"reason_code": _REASON_CREDITED_USER_MISSING})
        return
    logger.info(
        "gumroad_token_pack_clawed_back",
        extra={"reason_code": _REASON_CLAWED_BACK, "user_id": user_id, "amount": amount},
    )


async def _reverse_delivered_value(session: AsyncSession, stored: _StoredSale) -> None:
    """Undo whatever the stored sale delivered, per its product class.

    The two branches are disjoint because the allowlists are: a course
    refund writes no wallet audit row and a pack refund touches no
    entitlement. A product on neither allowlist reverses nothing — it
    delivered nothing either — but is flagged, since a sale that granted
    silently and now un-grants silently is exactly the drift an operator
    needs to see.
    """
    if is_aptitude_product_id(stored.product_id):
        await _revoke_course_access_for(session, stored, REASON_REFUND)
    elif is_token_pack_product_id(stored.product_id):
        amount = _claw_back_amount(stored)
        if amount is not None:
            await _debit_credited_account(session, stored, amount)
    else:
        logger.info(_SKIPPED_EVENT, extra={"reason_code": _REASON_UNKNOWN_PRODUCT})


async def process_refund(session: AsyncSession, payload: dict[str, str]) -> None:
    """Reverse the purchase a ``refund`` or ``dispute`` ping names.

    The money went back, so the claim is taken with ``refunded=True`` and
    whatever the stored sale delivered is undone: course access for an
    APTITUDE product, the full configured pack for a token pack, nothing at
    all for anything else. Every resolved sale is claimed even when there is
    nothing to reverse — an edge case that left the claim open would be a
    stale-redelivery trap, waiting to re-run against a wallet or an account
    that has since changed.

    Commits, so the claim lands with the reversal it authorised. A ping
    naming no stored purchase, or one that loses the claim race, returns
    having written nothing.
    """
    stored = await _resolve_stored_sale(session, payload)
    if stored is None:
        return
    if not await _take_revocation_claim(session, stored.sale_id, mark_refunded=True):
        return
    await _reverse_delivered_value(session, stored)
    await session.commit()


async def process_cancellation(session: AsyncSession, payload: dict[str, str]) -> None:
    """End future access for a ``cancellation`` or ``subscription_ended`` ping.

    Applies only to an APTITUDE sale: a subscription is the only thing there
    is to cancel. ``refunded`` stays False because the seller kept the
    payment, and the wallet is never touched.

    For anything else the handler is wholly inert — it takes no claim. That
    restraint is what protects the money: a one-time token pack cannot be
    cancelled, and letting a stray cancellation consume the shared guard
    would silently disarm the refund that may follow, leaving a refunded
    buyer holding every credit.

    Commits when it acts. A ping naming no stored purchase, or one that
    loses the claim race to an earlier reversal, returns having written
    nothing.
    """
    stored = await _resolve_stored_sale(session, payload)
    if stored is None:
        return
    if not is_aptitude_product_id(stored.product_id):
        logger.info(_SKIPPED_EVENT, extra={"reason_code": _REASON_NOT_APPLICABLE})
        return
    if not await _take_revocation_claim(session, stored.sale_id, mark_refunded=False):
        return
    await _revoke_course_access_for(session, stored, REASON_CANCELLATION)
    await session.commit()
