"""Claiming a Gumroad licence for an account — the ADR 0008 seam.

A claim is the moment a verified purchase turns into course access. Three
things must land together or not at all: the :class:`LicenseBinding` that
ties the sale to exactly one account, the ``course_access`` entitlement it
funds, and — on an account-creation path — the ``User`` row itself. So the
claim is *staged*, never committed, by :func:`stage_license_claim`, and the
caller owns the transaction. :func:`claim_license` is the convenience for
callers whose transaction is only the claim (the sale webhook).

The invariant is the database's, not this module's: ``licensebinding`` carries
a UNIQUE constraint on ``gumroad_sale_id``, so the pre-check here is a
courtesy that lets the common case answer without an exception, and the
``IntegrityError`` the constraint raises under a real race is folded into the
same :attr:`ClaimOutcome.BOUND_ELSEWHERE` answer. Callers turn that outcome
into whatever generic refusal their surface already uses — a valid key bound
to someone else must be indistinguishable from an unknown key on the wire
(Decision 2). Only the server log knows, via the WARNING carrying
``reason_code=license_already_bound`` (Decision 6).

Lifecycle: a binding is created on the first claim, survives revocation
(Decision 4 — a reactivated sale cannot drift to a second account while the
first lives) and is erased with the account (Decision 3). No email is
compared anywhere here: the sale id is the identity, and the raw licence key
never reaches this module at all.
"""

from __future__ import annotations

import enum
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

from sqlalchemy.exc import IntegrityError
from sqlmodel import col, select

from domain.entitlements import REASON_LICENSE_ALREADY_BOUND, stage_course_access
from models.entitlement import Entitlement
from models.gumroad_sale import GumroadSale
from models.license_binding import LicenseBinding

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from models.user import User

__all__ = [
    "ClaimOutcome",
    "bound_elsewhere",
    "claim_license",
    "find_binding",
    "new_claim_refused",
    "sale_reversed",
    "stage_license_claim",
]

logger = logging.getLogger(__name__)

# Structured-log event names. ``license_bound`` marks every successful claim;
# ``license_claim_rejected`` marks a claim the seam refused — at WARNING for a
# valid key presented by an account other than its holder (the anomalous-claim
# signal), at INFO for a sale whose reversal claim is already spent.
_BOUND_EVENT = "license_bound"
_REJECTED_EVENT = "license_claim_rejected"
# Same spelling the webhook uses for a redelivered, already-reversed sale.
_REASON_PREVIOUSLY_REVERSED = "sale_previously_reversed"


class ClaimOutcome(enum.Enum):
    """What presenting a verified purchase to an account amounted to."""

    #: The sale was unbound; this account now holds it and its entitlement.
    BOUND = "bound"
    #: The sale was already bound to this very account; nothing new was written.
    ALREADY_OWN = "already_own"
    #: The sale is bound to a different account; nothing was written.
    BOUND_ELSEWHERE = "bound_elsewhere"


def _require_user_id(user: User) -> int:
    """Return the persisted user's id, refusing an unflushed row."""
    if user.id is None:
        msg = "user id missing before license claim"
        raise ValueError(msg)
    return user.id


async def find_binding(session: AsyncSession, sale_id: str) -> LicenseBinding | None:
    """Return the binding that holds ``sale_id``, or ``None`` when it is unbound."""
    result = await session.execute(
        select(LicenseBinding).where(col(LicenseBinding.gumroad_sale_id) == sale_id)
    )
    return result.scalars().first()


def _log_rejected(claimant_id: int | None, binding_id: int | None) -> None:
    """Emit the anomalous-claim WARNING: a valid key presented by a non-holder.

    Ids only. ``claimant_id`` is ``None`` on an account-creation path, where
    the would-be holder has no row yet; the router's own refusal line
    (``signup_license_rejected`` / ``oauth_signin``) carries that surface's
    client fingerprint so the two can be correlated.
    """
    logger.warning(
        _REJECTED_EVENT,
        extra={
            "reason_code": REASON_LICENSE_ALREADY_BOUND,
            "user_id": claimant_id,
            "binding_id": binding_id,
        },
    )


async def _stored_sale(session: AsyncSession, sale_id: str) -> GumroadSale | None:
    """Return the webhook's stored row for ``sale_id``, if the ping has arrived yet.

    Read with ``populate_existing`` because a reversal writes its claim through
    SQL alone, so an instance this session already holds would still read as
    unreversed; the guards below have to see the row as the database has it.
    """
    result = await session.execute(
        select(GumroadSale)
        .where(col(GumroadSale.gumroad_sale_id) == sale_id)
        .execution_options(populate_existing=True)
    )
    return result.scalars().first()


async def sale_reversed(session: AsyncSession, sale_id: str) -> bool:
    """Return whether the stored sale's reversal claim is already spent.

    A refund, dispute, cancellation or subscription end is permanent for the
    sale that funded the access (ADR 0008 Decision 4), and Gumroad's verify
    keeps answering ``success`` for an ended subscription. The stamp on the
    stored row is therefore the one thing standing between a lapsed key and a
    fresh grant — including after the holder deletes their account and the
    binding goes with it. A sale the webhook has not stored yet is not
    reversed. Logs ``sale_previously_reversed`` when it answers ``True``.
    """
    sale = await _stored_sale(session, sale_id)
    if sale is None or sale.revocation_processed_at is None:
        return False
    logger.info(_REJECTED_EVENT, extra={"reason_code": _REASON_PREVIOUSLY_REVERSED})
    return True


async def bound_elsewhere(
    session: AsyncSession,
    sale_id: str,
    *,
    claimant_id: int | None = None,
) -> bool:
    """Return whether ``sale_id`` is bound to an account other than ``claimant_id``.

    A courtesy pre-check, not the invariant: the UNIQUE constraint on the
    binding still decides a genuine race, and :func:`claim_license` folds the
    loser into the same answer. Logs the WARNING when it answers ``True``.
    """
    binding = await find_binding(session, sale_id)
    if binding is None or binding.user_id == claimant_id:
        return False
    _log_rejected(claimant_id, binding.id)
    return True


async def new_claim_refused(session: AsyncSession, sale_id: str) -> bool:
    """Return whether a brand-new account may not claim ``sale_id``.

    The post-verify pre-check behind both creation paths' generic refusals.
    It runs after the outbound verify and before any hash or row, so a key
    that is reversed or already redeemed costs its presenter exactly what an
    unknown key costs and nothing is ever staged for it. No same-account case
    exists here, because the account does not exist yet.
    """
    return await sale_reversed(session, sale_id) or await bound_elsewhere(session, sale_id)


@dataclass(frozen=True)
class _StagedClaim:
    """What :func:`_stage_claim` put into the session, for the caller's log line."""

    outcome: ClaimOutcome
    binding: LicenseBinding | None = None
    entitlement: Entitlement | None = None


async def _stage_grant(
    session: AsyncSession,
    user_id: int,
    *,
    sale_id: str,
    product_id: str,
) -> Entitlement:
    """Stage the entitlement the claim funds, linked to the stored sale when present.

    The matching :class:`GumroadSale` row may not exist yet (a signup can beat
    the webhook), so the grant falls back to the purchase's product id and
    the link converges when the webhook replays the claim.
    """
    sale = await _stored_sale(session, sale_id)
    return await stage_course_access(session, user_id, sale, product_id)


async def _stage_claim(
    session: AsyncSession,
    user: User,
    *,
    sale_id: str,
    product_id: str,
) -> _StagedClaim:
    """Stage the claim and hand back the rows it staged, ids pending flush."""
    user_id = _require_user_id(user)
    binding = await find_binding(session, sale_id)
    if binding is None:
        binding = LicenseBinding(user_id=user_id, gumroad_sale_id=sale_id, product_id=product_id)
        session.add(binding)
        entitlement = await _stage_grant(session, user_id, sale_id=sale_id, product_id=product_id)
        return _StagedClaim(ClaimOutcome.BOUND, binding, entitlement)
    if binding.user_id == user_id:
        entitlement = await _stage_grant(session, user_id, sale_id=sale_id, product_id=product_id)
        return _StagedClaim(ClaimOutcome.ALREADY_OWN, binding, entitlement)
    _log_rejected(user_id, binding.id)
    return _StagedClaim(ClaimOutcome.BOUND_ELSEWHERE)


async def stage_license_claim(
    session: AsyncSession,
    user: User,
    *,
    sale_id: str,
    product_id: str,
) -> ClaimOutcome:
    """Stage ``user``'s claim on ``sale_id`` into ``session`` without committing.

    ``BOUND`` adds the binding and stages the entitlement; ``ALREADY_OWN``
    re-stages the existing entitlement so a replay converges (a refreshed
    sale link, for instance) and adds no second binding; ``BOUND_ELSEWHERE``
    writes nothing and logs the WARNING. The caller commits — or, on
    ``BOUND_ELSEWHERE``, rolls back whatever else it had staged, because a
    claim that fails must leave no orphan account behind it. The success
    line is the committing caller's to write, since only it knows the claim
    landed.
    """
    return (await _stage_claim(session, user, sale_id=sale_id, product_id=product_id)).outcome


def _log_bound(user_id: int, staged: _StagedClaim, *, reason_code: str) -> None:
    """Emit ``license_bound`` with ids only, read off the rows the claim staged.

    Safe after the commit because both session factories run with
    ``expire_on_commit=False``: the ids were assigned at flush and are still
    loaded, so no query and no lazy load is needed.
    """
    logger.info(
        _BOUND_EVENT,
        extra={
            "reason_code": reason_code,
            "user_id": user_id,
            "binding_id": None if staged.binding is None else staged.binding.id,
            "entitlement_id": None if staged.entitlement is None else staged.entitlement.id,
        },
    )


async def claim_license(
    session: AsyncSession,
    user: User,
    *,
    sale_id: str,
    product_id: str,
    reason_code: str,
) -> ClaimOutcome:
    """Stage the claim and commit it, folding a lost race into ``BOUND_ELSEWHERE``.

    The UNIQUE constraint on ``gumroad_sale_id`` is what makes two racing
    first claims yield one winner: the loser's insert raises
    :class:`IntegrityError` at flush, the session is rolled back — taking
    with it anything else the caller staged in the same transaction — and the
    answer is the same generic ``BOUND_ELSEWHERE`` the pre-check gives.
    """
    try:
        staged = await _stage_claim(session, user, sale_id=sale_id, product_id=product_id)
        if staged.outcome is ClaimOutcome.BOUND_ELSEWHERE:
            await session.rollback()
            return staged.outcome
        await session.commit()
    except IntegrityError:
        await session.rollback()
        return ClaimOutcome.BOUND_ELSEWHERE
    _log_bound(_require_user_id(user), staged, reason_code=reason_code)
    return staged.outcome
