"""Gumroad product classification plus course-access entitlement logic.

Two concerns live together here on purpose. The first is classifying what a
Gumroad product id *is* — the APTITUDE course
(``GUMROAD_APTITUDE_PRODUCT_IDS``) or a BotMason token pack
(``GUMROAD_TOKEN_PACK_PRODUCT_IDS`` plus its per-product sizes in
``GUMROAD_TOKEN_PACK_SIZES``). One module owning every allowlist is what
keeps the classifications from drifting apart, so a product can never both
grant the course and mint credits by accident. Every allowlist is read at
call time, so a rotation needs no restart, and every one fails closed: unset
means "matches nothing".

The second is the course-access entitlement itself: the grant is idempotent
(at most one active ``course_access`` row per user, backed by the partial
unique index on the model) and every grant / revoke emits a structured log
line carrying a ``reason_code`` — never a raw email or license key, only ids.

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
    "TOKEN_PACK_PRODUCT_IDS_ENV_VAR",
    "TOKEN_PACK_SIZES_ENV_VAR",
    "AptitudeLicenseCheck",
    "GumroadUnavailableError",
    "LicenseOutcome",
    "grant_course_access",
    "has_course_access",
    "is_aptitude_product_id",
    "is_token_pack_product_id",
    "revoke_course_access",
    "token_pack_product_ids",
    "token_pack_size",
    "verify_aptitude_license",
]

logger = logging.getLogger(__name__)

# Structured-log reason codes for every entitlement transition. One constant
# per code so grep-by-reason in log aggregation has a single spelling.
REASON_SIGNUP_REDEMPTION = "signup_redemption"
REASON_WEBHOOK_SALE = "webhook_sale"
# Forward-reserved for the post-grant revocation paths (refund-driven and
# manual admin override); exported now so those code paths share this spelling.
REASON_REFUND = "refund"
REASON_ADMIN_OVERRIDE = "admin_override"
REASON_DUPLICATE_SIGNUP = "duplicate_signup"
REASON_EMAIL_MISMATCH = "email_mismatch"

# Comma-separated allowlist of Gumroad product ids that count as "the
# APTITUDE course". Read at call time so a rotation needs no restart (and so
# tests can monkeypatch the environment).
PRODUCT_IDS_ENV_VAR = "GUMROAD_APTITUDE_PRODUCT_IDS"
_PRODUCT_IDS_SEPARATOR = ","

# The token-pack half of the classification: which products are credit packs,
# and how many credits each one is worth. Kept as two variables because the
# allowlist is the security gate (is this a pack at all?) while the size map
# is the money (how much?) — an operator can add a product to the allowlist
# and see it credit nothing until they price it, rather than have a typo in
# one variable silently mint an unintended amount.
#
# Both values are environment-variable *names*, not credentials; S105 fires
# only because the constant names contain "token", the same false positive
# ``_SECRET_PLACEHOLDER`` in the auth router silences.
TOKEN_PACK_PRODUCT_IDS_ENV_VAR = "GUMROAD_TOKEN_PACK_PRODUCT_IDS"  # noqa: S105  # nosec B105  # pragma: allowlist secret
TOKEN_PACK_SIZES_ENV_VAR = "GUMROAD_TOKEN_PACK_SIZES"  # noqa: S105  # nosec B105  # pragma: allowlist secret
# ``GUMROAD_TOKEN_PACK_SIZES`` is ``product_id:count`` entries joined by
# ``_PRODUCT_IDS_SEPARATOR``. Gumroad product ids never contain a colon, so
# the first colon is an unambiguous field boundary.
_SIZE_FIELD_SEPARATOR = ":"


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


def _split_ids(raw: str) -> list[str]:
    """Parse one comma-separated product allowlist into stripped, non-blank ids.

    Shared by both allowlists so they cannot diverge on tolerance: padding,
    empty entries, and a trailing separator in the deployment config are all
    harmless, and an empty string yields an empty list rather than one blank
    id that would match a product-less ping.
    """
    return [
        product_id.strip() for product_id in raw.split(_PRODUCT_IDS_SEPARATOR) if product_id.strip()
    ]


def _allowlisted_product_ids() -> list[str]:
    """Read the APTITUDE product allowlist from the environment at call time.

    An unset variable yields an empty allowlist, which makes every key verify
    as INVALID.
    """
    return _split_ids(os.getenv(PRODUCT_IDS_ENV_VAR, ""))


def token_pack_product_ids() -> list[str]:
    """Read the token-pack product allowlist from the environment at call time.

    An unset variable yields an empty allowlist, so no sale can be classified
    as a token pack until an operator configures one.
    """
    return _split_ids(os.getenv(TOKEN_PACK_PRODUCT_IDS_ENV_VAR, ""))


def is_token_pack_product_id(product_id: str | None) -> bool:
    """Return True when ``product_id`` is on the token-pack allowlist.

    Mirrors :func:`is_aptitude_product_id`: a blank or unallowlisted id
    (including an unset allowlist) returns False, so a sale of any other
    product sold on the same Gumroad account can never mint wallet credits.
    """
    normalized = (product_id or "").strip()
    return bool(normalized) and normalized in token_pack_product_ids()


def _is_positive_count(raw: str) -> bool:
    """Return True when ``raw`` is a plain ASCII decimal integer above zero.

    ``isascii()`` rejects the non-ASCII digits ``isdigit()`` otherwise
    accepts (full-width numerals, for instance) so the value that reaches
    ``int()`` is always the one an operator can read back out of the config.
    Zero and anything negative are rejected too: a non-positive pack size
    would turn a purchase into a no-op or, worse, a debit.
    """
    return raw.isascii() and raw.isdigit() and int(raw) > 0


def _parse_size_entry(entry: str) -> tuple[str, int] | None:
    """Parse one ``product_id:count`` entry, or ``None`` when it is malformed.

    Malformed entries are dropped rather than defaulted — there is no safe
    fallback size for real money, and a neighbouring well-formed entry must
    stay usable regardless of a typo elsewhere in the variable.
    """
    product_id, separator, raw_count = entry.partition(_SIZE_FIELD_SEPARATOR)
    normalized_id = product_id.strip()
    count = raw_count.strip()
    if not separator or not normalized_id or not _is_positive_count(count):
        return None
    return normalized_id, int(count)


def _token_pack_sizes() -> dict[str, int]:
    """Read the token-pack size map from the environment at call time.

    An unset variable yields an empty map, which makes every pack credit
    nothing. A product id repeated across entries resolves to the right-most
    one, matching how ``dict`` folds duplicate keys.
    """
    raw = os.getenv(TOKEN_PACK_SIZES_ENV_VAR, "")
    parsed = (_parse_size_entry(entry) for entry in raw.split(_PRODUCT_IDS_SEPARATOR))
    return dict(entry for entry in parsed if entry is not None)


def token_pack_size(product_id: str | None) -> int | None:
    """Return the configured credit count for ``product_id``, or ``None``.

    ``None`` means "no size is configured", which every caller must treat as
    "credit nothing" — a missing or malformed size is never substituted with
    a default. A blank or absent id answers ``None`` rather than raising.
    """
    normalized = (product_id or "").strip()
    if not normalized:
        return None
    return _token_pack_sizes().get(normalized)


def is_aptitude_product_id(product_id: str | None) -> bool:
    """Return True when ``product_id`` is on the APTITUDE course allowlist.

    Shares the single allowlist source (``GUMROAD_APTITUDE_PRODUCT_IDS``) with
    the signup verifier so the webhook sale-grant path and the signup path can
    never diverge on what counts as "the course". A blank or unallowlisted id
    (including an unset allowlist) returns False, so the grant fails closed for
    any non-APTITUDE product sold on the same Gumroad account.
    """
    normalized = (product_id or "").strip()
    return bool(normalized) and normalized in _allowlisted_product_ids()


async def verify_aptitude_license(
    email: str,
    license_key: str | None,
    *,
    client: httpx.AsyncClient | None = None,
) -> AptitudeLicenseCheck:
    """Verify ``license_key`` against every allowlisted APTITUDE product.

    A missing or blank ``license_key`` short-circuits to LICENSE_REQUIRED
    before any Gumroad call. Otherwise walks ``GUMROAD_APTITUDE_PRODUCT_IDS``
    in order, stopping on the first ``success`` answer: a reversed purchase
    (refunded, charged back, or under an unresolved dispute) yields INVALID, a
    case-insensitive email match on a live purchase yields VERIFIED (with the
    purchase attached), any other
    holder yields EMAIL_MISMATCH. A ``None`` / ``success=False`` answer moves
    on to the next product; no match across the whole allowlist is INVALID.

    Raises:
        GumroadUnavailableError: propagated untouched from ``verify_license``
            so the caller can fail closed (the route maps it to 503).
    """
    key = (license_key or "").strip()
    if not key:
        return AptitudeLicenseCheck(LicenseOutcome.LICENSE_REQUIRED)
    normalized_email = email.strip().lower()
    return await _first_license_match(key, normalized_email, client)


def _is_reversed_purchase(purchase: GumroadPurchase) -> bool:
    """Return whether a verified purchase has been reversed by the buyer.

    Gumroad's documented verify response (app.gumroad.com/api) exposes reversal
    as four booleans; a purchase counts as reversed when it was refunded,
    charged back, or is under an unresolved chargeback dispute — ``disputed``
    that the seller has not yet won (``dispute_won``). A won dispute leaves the
    sale legitimate, so it does not reject. This is best-effort pre-grant
    screening only.
    """
    unresolved_dispute = purchase.disputed and not purchase.dispute_won
    return purchase.refunded or purchase.chargebacked or unresolved_dispute


def _classify_verified_purchase(
    purchase: GumroadPurchase,
    normalized_email: str,
) -> AptitudeLicenseCheck:
    """Map a successful verify result onto INVALID, VERIFIED, or EMAIL_MISMATCH.

    A reversed purchase folds to INVALID before the email is even compared, so
    the rejection is byte-for-byte identical to an unknown key and never leaks
    that the license was once valid. This is pre-grant verification only;
    revoking an already-granted entitlement after a later refund is separate,
    deferred work.
    """
    if _is_reversed_purchase(purchase):
        return AptitudeLicenseCheck(LicenseOutcome.INVALID)
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
