"""A membership's life after its purchase: cancel, end, restart (#3259).

The owner's cancel-timing decision (2026-10-14): "Change nothing at the cancel
click; restrict AI when the period ends; give access back on a restart."

* ``cancellation`` is the click. The member has paid for the period they are
  in, so it changes no access: the sale is stamped
  ``subscription_cancelled_at`` for the audit and nothing else moves.
* ``subscription_ended`` is the period running out. The licence holder's
  ``course_access`` is revoked with :data:`REASON_SUBSCRIPTION_ENDED`, which
  restricts operator-funded AI exactly as a refund does; the free core stays
  open (``domain.entitlements.ai_access_revoked``).
* ``subscription_restarted`` gives that back -- but only an access *this*
  sale's ending took away. An access revoked by a refund, a dispute or an
  operator stays revoked.

None of the three touches the sale's one-time reversal claim
(``revocation_processed_at``): that belongs to the money events in
:mod:`services.gumroad_revocation`, so a refund or dispute after a
cancellation or an ending still applies in full.

Ordering is by Gumroad's own event time (``cancelled_at``, ``ended_at``,
``restarted_at``) where the ping carries one, falling back to the moment of
receipt. Each kind's latest time is kept on the sale and only ever advances,
via a guarded ``UPDATE ... WHERE stamp IS NULL OR stamp < :at``: a replayed
ping finds its own time already recorded and moves nothing, and a stale one
arriving after a newer event of the other kind is outranked by it
(:func:`models.gumroad_sale.subscription_has_ended`).

Like the refund handler, every fact acted on comes off the stored purchase row
and the licence binding, never off the ping: the access changed is the one on
the account the binding names (ADR 0008 Decision 4).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, cast

from sqlalchemy import CursorResult, or_, update
from sqlmodel import col, select

from domain.entitlements import (
    REASON_SUBSCRIPTION_ENDED,
    REASON_SUBSCRIPTION_RESTARTED,
    REVOCATION_REASON_CODE_KEY,
    REVOKED_BY_SALE_KEY,
    grant_course_access,
    has_course_access,
    is_aptitude_product_id,
    latest_course_revocation,
    revoke_course_access,
)
from domain.license_claims import find_binding
from models.gumroad_sale import SALE_RESOURCE_NAME, GumroadSale, subscription_has_ended
from models.user import User

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession
    from sqlalchemy.orm import Mapped

__all__ = [
    "process_cancellation",
    "process_subscription_ended",
    "process_subscription_restarted",
]

logger = logging.getLogger(__name__)

# The ping fields Gumroad stamps each membership event with.
_CANCELLED_AT_FIELD = "cancelled_at"
_ENDED_AT_FIELD = "ended_at"
_RESTARTED_AT_FIELD = "restarted_at"

# Structured-log reason codes. The skip codes shared with the refund handler
# keep their spelling so one log query covers both modules.
_SKIPPED_EVENT = "gumroad_reversal_skipped"
_REASON_UNKNOWN_SALE = "unknown_sale"
_REASON_NOT_APPLICABLE = "cancellation_not_applicable"
_REASON_SALE_NOT_BOUND = "sale_not_bound"
_REASON_STALE_EVENT = "subscription_event_stale"
_REASON_EVENT_TIME_UNPARSED = "subscription_event_time_unparsed"
_REASON_SALE_REVERSED = "subscription_restart_after_reversal"
_REASON_NOTHING_TO_RESTORE = "subscription_restart_nothing_to_restore"
_REASON_CANCELLATION_RECORDED = "cancellation_recorded"
_SUBSCRIPTION_EVENT = "gumroad_subscription_event"


def _event_time(payload: dict[str, str], field: str) -> datetime:
    """Return the ping's own event time for ``field``, or now when it has none.

    A value present but unreadable is logged rather than trusted, and falls
    back to the moment of receipt like an absent one.
    """
    raw = payload.get(field, "").strip()
    if raw:
        try:
            parsed = datetime.fromisoformat(raw)
        except ValueError:
            logger.info(_SKIPPED_EVENT, extra={"reason_code": _REASON_EVENT_TIME_UNPARSED})
        else:
            return parsed.astimezone(UTC) if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return datetime.now(UTC)


async def _resolve_membership_sale(
    session: AsyncSession, payload: dict[str, str]
) -> GumroadSale | None:
    """Return the stored APTITUDE purchase this ping names, or ``None``.

    Requires ``resource_name == "sale"`` for the same reason the refund
    handler does: an orphan ping is itself persisted under its ``sale_id``,
    and must never be mistaken for the purchase. A sale of anything other
    than the course is not a membership, so the ping is inert for it.
    """
    result = await session.execute(
        select(GumroadSale)
        .where(
            col(GumroadSale.gumroad_sale_id) == payload["sale_id"],
            col(GumroadSale.resource_name) == SALE_RESOURCE_NAME,
        )
        .execution_options(populate_existing=True)
    )
    sale = result.scalars().first()
    if sale is None:
        logger.info(_SKIPPED_EVENT, extra={"reason_code": _REASON_UNKNOWN_SALE})
        return None
    if not is_aptitude_product_id(sale.product_id):
        logger.info(_SKIPPED_EVENT, extra={"reason_code": _REASON_NOT_APPLICABLE})
        return None
    return sale


async def _advance_stamp(
    session: AsyncSession,
    sale: GumroadSale,
    stamp: Mapped[datetime | None],
    at: datetime,
    *,
    first_only: bool = False,
) -> bool:
    """Move ``stamp`` forward to ``at``, returning whether this ping did.

    One conditional ``UPDATE`` is the whole guard: a replay carrying the same
    time, or an older one, matches no row and so changes nothing.
    ``first_only`` keeps the earliest value instead (the cancellation audit).
    ``synchronize_session=False`` for the reason the refund claim gives: the
    sale already sits in the identity map, and the stored value is re-read
    with ``populate_existing`` before anything relies on it.
    """
    guard = stamp.is_(None) if first_only else or_(stamp.is_(None), stamp < at)
    result = await session.execute(
        update(GumroadSale)
        .where(col(GumroadSale.id) == sale.id, guard)
        .values({stamp: at})
        .execution_options(synchronize_session=False)
    )
    return bool(cast("CursorResult[Any]", result).rowcount)


async def _reload(session: AsyncSession, sale: GumroadSale) -> GumroadSale:
    """Re-read ``sale`` as the database now has it, stamps included."""
    result = await session.execute(
        select(GumroadSale)
        .where(col(GumroadSale.id) == sale.id)
        .execution_options(populate_existing=True)
    )
    return result.scalars().one()


def _log_stale() -> None:
    """Record a membership ping that an equal or newer event already outranks."""
    logger.info(_SKIPPED_EVENT, extra={"reason_code": _REASON_STALE_EVENT})


async def process_cancellation(session: AsyncSession, payload: dict[str, str]) -> None:
    """Record a ``cancellation`` ping for the audit, and change no access.

    The member keeps the course and AI until the period they paid for ends,
    which Gumroad reports separately as ``subscription_ended``. Only the
    first cancellation is kept, so a replay is a no-op; the reversal claim is
    never touched, so a later refund or dispute still applies in full.
    """
    sale = await _resolve_membership_sale(session, payload)
    if sale is None:
        return
    at = _event_time(payload, _CANCELLED_AT_FIELD)
    stamp = col(GumroadSale.subscription_cancelled_at)
    if not await _advance_stamp(session, sale, stamp, at, first_only=True):
        _log_stale()
        return
    await session.commit()
    logger.info(_SUBSCRIPTION_EVENT, extra={"reason_code": _REASON_CANCELLATION_RECORDED})


async def process_subscription_ended(session: AsyncSession, payload: dict[str, str]) -> None:
    """Revoke the licence holder's access because the paid period has ended.

    Revoked with :data:`REASON_SUBSCRIPTION_ENDED` and the sale id, so the AI
    restriction applies and a later restart can recognise its own ending. An
    ending older than a restart already recorded is outranked and moves no
    access. The reversal claim is untouched, and ``refunded`` stays False
    because the seller kept the payment.
    """
    sale = await _resolve_membership_sale(session, payload)
    if sale is None:
        return
    at = _event_time(payload, _ENDED_AT_FIELD)
    stamp = col(GumroadSale.subscription_ended_at)
    if not await _advance_stamp(session, sale, stamp, at):
        _log_stale()
        return
    sale = await _reload(session, sale)
    if subscription_has_ended(sale):
        await _revoke_for_ending(session, sale.gumroad_sale_id)
    else:
        _log_stale()
    await session.commit()


async def _revoke_for_ending(session: AsyncSession, sale_id: str) -> None:
    """Revoke course access on the account the sale's binding names, if any."""
    binding = await find_binding(session, sale_id)
    if binding is None:
        logger.info(_SKIPPED_EVENT, extra={"reason_code": _REASON_SALE_NOT_BOUND})
        return
    await revoke_course_access(session, binding.user_id, REASON_SUBSCRIPTION_ENDED, sale_id=sale_id)


async def process_subscription_restarted(session: AsyncSession, payload: dict[str, str]) -> None:
    """Give back the access this sale's ending took away.

    Re-grants only when every one of these holds: the restart is the latest
    membership event on the sale, the sale's money has not been reversed (a
    refund or dispute is permanent), the licence holder has no live access,
    and their most recent revocation is this sale's own ending. Anything else
    -- an operator's revocation, a refund, an ending that never happened --
    is left exactly as it is.
    """
    sale = await _resolve_membership_sale(session, payload)
    if sale is None:
        return
    at = _event_time(payload, _RESTARTED_AT_FIELD)
    stamp = col(GumroadSale.subscription_restarted_at)
    if not await _advance_stamp(session, sale, stamp, at):
        _log_stale()
        return
    sale = await _reload(session, sale)
    user = await _restorable_holder(session, sale)
    if user is None:
        await session.commit()
        return
    await grant_course_access(session, user, sale, reason_code=REASON_SUBSCRIPTION_RESTARTED)


async def _restorable_holder(session: AsyncSession, sale: GumroadSale) -> User | None:
    """Return the account whose ended access this restart restores, or ``None``.

    Each refusal is logged with its own reason code, so an operator can tell
    a restart that was outranked from one that had nothing to give back.
    """
    if subscription_has_ended(sale):
        _log_stale()
        return None
    if sale.revocation_processed_at is not None:
        logger.info(_SKIPPED_EVENT, extra={"reason_code": _REASON_SALE_REVERSED})
        return None
    binding = await find_binding(session, sale.gumroad_sale_id)
    if binding is None:
        logger.info(_SKIPPED_EVENT, extra={"reason_code": _REASON_SALE_NOT_BOUND})
        return None
    if not await _ended_by_this_sale(session, binding.user_id, sale.gumroad_sale_id):
        logger.info(_SKIPPED_EVENT, extra={"reason_code": _REASON_NOTHING_TO_RESTORE})
        return None
    return await session.get(User, binding.user_id)


async def _ended_by_this_sale(session: AsyncSession, user_id: int, sale_id: str) -> bool:
    """Whether the account's access is down, and down because ``sale_id`` ended."""
    if await has_course_access(session, user_id):
        return False
    latest = await latest_course_revocation(session, user_id)
    if latest is None:
        return False
    metadata = latest.entitlement_metadata
    return (
        metadata.get(REVOCATION_REASON_CODE_KEY) == REASON_SUBSCRIPTION_ENDED
        and metadata.get(REVOKED_BY_SALE_KEY) == sale_id
    )
