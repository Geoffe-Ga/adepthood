"""Course-access entitlement domain logic: grant, check, revoke, verify.

The grant is idempotent (at most one active ``course_access`` row per user,
backed by the partial unique index on the model) and every grant / revoke
emits a structured log line carrying a ``reason_code`` — never a raw email
or license key, only ids.

:func:`verify_aptitude_license` is the signup gate's verifier: it walks the
``GUMROAD_APTITUDE_PRODUCT_IDS`` allowlist calling the Gumroad client's
``verify_license`` (tests patch ``domain.entitlements.verify_license``) and
folds the answers into a three-way :class:`LicenseOutcome`. A Gumroad outage
(:class:`GumroadUnavailableError`, re-exported here for callers) propagates
untouched so the route can fail closed.
"""

from __future__ import annotations

import enum
import logging
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlmodel import col, select

from integrations.gumroad import GumroadUnavailableError, verify_license
from models.entitlement import Entitlement, EntitlementKind

if TYPE_CHECKING:
    import httpx
    from sqlalchemy.ext.asyncio import AsyncSession

    from models.gumroad_sale import GumroadSale
    from models.user import User
    from schemas.gumroad import GumroadPurchase

__all__ = [
    "PRODUCT_IDS_ENV_VAR",
    "REASON_ADMIN_OVERRIDE",
    "REASON_DUPLICATE_SIGNUP",
    "REASON_EMAIL_MISMATCH",
    "REASON_REFUND",
    "REASON_SIGNUP_REDEMPTION",
    "REASON_WEBHOOK_SALE",
    "AptitudeLicenseCheck",
    "GumroadUnavailableError",
    "LicenseOutcome",
    "grant_course_access",
    "has_course_access",
    "revoke_course_access",
    "verify_aptitude_license",
]

logger = logging.getLogger(__name__)

# Structured-log reason codes for every entitlement transition. One constant
# per code so grep-by-reason in log aggregation has a single spelling.
REASON_SIGNUP_REDEMPTION = "signup_redemption"
REASON_WEBHOOK_SALE = "webhook_sale"
REASON_REFUND = "refund"
REASON_ADMIN_OVERRIDE = "admin_override"
REASON_DUPLICATE_SIGNUP = "duplicate_signup"
REASON_EMAIL_MISMATCH = "email_mismatch"

# Comma-separated allowlist of Gumroad product ids that count as "the
# APTITUDE course". Read at call time so a rotation needs no restart (and so
# tests can monkeypatch the environment).
PRODUCT_IDS_ENV_VAR = "GUMROAD_APTITUDE_PRODUCT_IDS"
_PRODUCT_IDS_SEPARATOR = ","


class LicenseOutcome(enum.Enum):
    """Outcome of an APTITUDE license verification."""

    VERIFIED = "verified"
    INVALID = "invalid"
    EMAIL_MISMATCH = "email_mismatch"
    LICENSE_REQUIRED = "license_required"


@dataclass(frozen=True)
class AptitudeLicenseCheck:
    """A verification outcome plus, on VERIFIED, the matched purchase."""

    outcome: LicenseOutcome
    purchase: GumroadPurchase | None = None


async def _find_active_entitlement(session: AsyncSession, user_id: int) -> Entitlement | None:
    """Return the user's active ``course_access`` entitlement, if any."""
    result = await session.execute(
        select(Entitlement).where(
            Entitlement.user_id == user_id,
            Entitlement.kind == EntitlementKind.COURSE_ACCESS,
            col(Entitlement.revoked_at).is_(None),
        )
    )
    return result.scalars().first()


def _apply_grant_provenance(
    entitlement: Entitlement,
    sale: GumroadSale | None,
    product_id: str | None,
) -> None:
    """Stamp sale/product provenance onto ``entitlement`` without erasing it.

    A passed ``sale`` supplies both the sale link and the product id; with no
    sale the explicit ``product_id`` alone applies. Existing values survive a
    bare re-grant because only non-``None`` sources overwrite them.
    """
    if sale is not None:
        entitlement.source_sale_id = sale.id
        entitlement.product_id = sale.product_id
    elif product_id is not None:
        entitlement.product_id = product_id


async def grant_course_access(
    session: AsyncSession,
    user: User,
    sale: GumroadSale | None = None,
    *,
    product_id: str | None = None,
    reason_code: str = REASON_SIGNUP_REDEMPTION,
) -> Entitlement:
    """Grant (or refresh) the user's active ``course_access`` entitlement.

    Idempotent: when an active grant already exists its sale link is updated
    in place — never a duplicate row. When ``sale`` is passed the link
    (``source_sale_id`` and ``product_id``) is derived from it; otherwise the
    explicit ``product_id`` keyword applies. Existing link values are only
    overwritten by non-``None`` derivations so a bare re-grant cannot erase
    provenance. Commits, then logs ``entitlement_granted`` with
    ``reason_code`` (ids only — never emails or keys).
    """
    if user.id is None:
        msg = "user id missing before entitlement grant"
        raise ValueError(msg)
    entitlement = await _find_active_entitlement(session, user.id)
    if entitlement is None:
        entitlement = Entitlement(user_id=user.id)
    _apply_grant_provenance(entitlement, sale, product_id)
    session.add(entitlement)
    await session.commit()
    await session.refresh(entitlement)
    logger.info(
        "entitlement_granted",
        extra={
            "reason_code": reason_code,
            "user_id": user.id,
            "entitlement_id": entitlement.id,
        },
    )
    return entitlement


async def has_course_access(session: AsyncSession, user_id: int) -> bool:
    """Return True when ``user_id`` holds an active ``course_access`` grant."""
    return await _find_active_entitlement(session, user_id) is not None


async def revoke_course_access(session: AsyncSession, user_id: int, reason: str) -> None:
    """Revoke the user's active ``course_access`` entitlement, if any.

    Sets ``revoked_at`` on the active row (freeing the partial-unique slot so
    a later re-grant creates a fresh row), commits, and logs
    ``entitlement_revoked`` with ``reason_code=reason``. A user with no
    active grant is a silent no-op.
    """
    entitlement = await _find_active_entitlement(session, user_id)
    if entitlement is None:
        return
    entitlement.revoked_at = datetime.now(UTC)
    session.add(entitlement)
    await session.commit()
    logger.info(
        "entitlement_revoked",
        extra={
            "reason_code": reason,
            "user_id": user_id,
            "entitlement_id": entitlement.id,
        },
    )


def _allowlisted_product_ids() -> list[str]:
    """Read the APTITUDE product allowlist from the environment at call time.

    Splits on commas, strips whitespace, and skips blanks so trailing
    separators in the deployment config are harmless. An unset variable
    yields an empty allowlist, which makes every key verify as INVALID.
    """
    raw = os.getenv(PRODUCT_IDS_ENV_VAR, "")
    return [
        product_id.strip() for product_id in raw.split(_PRODUCT_IDS_SEPARATOR) if product_id.strip()
    ]


async def verify_aptitude_license(
    email: str,
    license_key: str | None,
    *,
    client: httpx.AsyncClient | None = None,
) -> AptitudeLicenseCheck:
    """Verify ``license_key`` against every allowlisted APTITUDE product.

    A missing or blank ``license_key`` short-circuits to LICENSE_REQUIRED
    before any Gumroad call. Otherwise walks ``GUMROAD_APTITUDE_PRODUCT_IDS``
    in order, stopping on the first ``success`` answer: a case-insensitive
    email match yields VERIFIED (with the purchase attached), any other holder
    yields EMAIL_MISMATCH. A ``None`` / ``success=False`` answer moves on to
    the next product; no match across the whole allowlist is INVALID.

    Raises:
        GumroadUnavailableError: propagated untouched from ``verify_license``
            so the caller can fail closed (the route maps it to 503).
    """
    key = (license_key or "").strip()
    if not key:
        return AptitudeLicenseCheck(LicenseOutcome.LICENSE_REQUIRED)
    normalized_email = email.strip().lower()
    return await _first_license_match(key, normalized_email, client)


def _classify_verified_purchase(
    purchase: GumroadPurchase,
    normalized_email: str,
) -> AptitudeLicenseCheck:
    """Map a successful verify result onto VERIFIED or EMAIL_MISMATCH."""
    if purchase.email.strip().lower() == normalized_email:
        return AptitudeLicenseCheck(LicenseOutcome.VERIFIED, purchase)
    return AptitudeLicenseCheck(LicenseOutcome.EMAIL_MISMATCH)


async def _first_license_match(
    license_key: str,
    normalized_email: str,
    client: httpx.AsyncClient | None,
) -> AptitudeLicenseCheck:
    """Return the first allowlisted product's verdict, or INVALID if none match."""
    for product_id in _allowlisted_product_ids():
        result = await verify_license(product_id, license_key, client=client)
        if result is not None and result.success:
            return _classify_verified_purchase(result.purchase, normalized_email)
    return AptitudeLicenseCheck(LicenseOutcome.INVALID)
