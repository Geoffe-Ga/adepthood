"""The resonance pass's local care surface and its no-reflection responses.

Moved out of :mod:`routers.journal` unchanged, so the router stays within its
maintainability budget. Everything here is local and free: the distress screen
is pure (no network, no model), and every response it builds reads the wallet
fresh without charging. Care never depends on a reflection, a vault, or -- since
#3096 -- on whether anybody can pay for one (NORTH-STAR §10).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import HTTPException

from domain.care import CarePayload, build_care_payload
from domain.safety import assess_distress
from schemas.marginalia import CareResourceResponse, CareResponse, ResonanceResponse
from services.usage import get_monthly_cap
from services.wallet import require_user_fresh

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from models.user import User


def care_for(body: str) -> CarePayload | None:
    """Screen ``body`` and return the care payload on an elevated signal, else None.

    Pure and local (no network/LLM): :func:`assess_distress` cannot fail the
    request, and the payload is built from reviewable constants — derived from
    this entry alone, so it can never leak across users.
    """
    if assess_distress(body).level == "elevated":
        return build_care_payload()
    return None


def care_surface(payload: CarePayload) -> CareResponse:
    """Map a care payload onto its response DTO.

    Split out from :func:`care_response` so the paths that already know they
    have a payload — the vault's care escalation among them — can build the
    surface without a cast through an optional.
    """
    return CareResponse(
        title=payload.title,
        message=payload.message,
        resources=[
            CareResourceResponse(
                kind=resource.kind,
                name=resource.name,
                contact=resource.contact,
                what_it_is=resource.what_it_is,
            )
            for resource in payload.resources
        ],
    )


def care_response(payload: CarePayload | None) -> CareResponse | None:
    """Map a care payload to its response DTO, or ``None`` when not flagged."""
    return None if payload is None else care_surface(payload)


# Non-shaming copy shown when an intimate entry is kept off the cloud (issue #895).
# The exact string is contract with the client and the RED tests — one named
# constant so the wording lives in a single place.
INTIMATE_PRIVATE_MESSAGE = (
    "This entry stays private — it's not sent to any AI. Change its privacy to enable reflection."
)


def unspent_resonance(
    user: User,
    *,
    care: CareResponse | None,
    private: bool = False,
    private_message: str | None = None,
) -> ResonanceResponse:
    """Build a no-reflection response over the caller's *unspent* wallet balances.

    Shared skeleton for the two paths that return before any charge lands: the
    intimate/private path and the care-only fallback when an elevated entry's
    LLM pass fails. Both surface empty marginalia + suggestions
    and read the wallet fresh (no ``preflight_deduction``), differing only in
    the ``care`` payload and the private-message fields.
    """
    return ResonanceResponse(
        marginalia=[],
        suggestions=[],
        remaining_messages=max(get_monthly_cap() - user.monthly_messages_used, 0),
        remaining_balance=user.offering_balance,
        monthly_reset_date=user.monthly_reset_date,
        care=care,
        private=private,
        private_message=private_message,
    )


async def private_response(
    session: AsyncSession, user_id: int, care: CareResponse | None
) -> ResonanceResponse:
    """Resonance response for an intimate entry: no model call, no net charge.

    An ``intimate`` entry is never sent to a language model (issue #895), so this
    is returned *before* any LLM construction: no marginalia, no suggestions,
    unspent balances (read fresh, like :func:`care_only_response`), and the
    non-shaming private message. On the usual path it is returned before any
    wallet deduction too. When the entry only became intimate while the pass
    waited for the account barrier, :func:`_withdrawn_under_hold` has already
    refunded the committed deduction before calling this, so the balances it
    reads are unspent on that path as well (#2998).

    ``care`` is the locally-screened surface (never None-forced): a distressed
    intimate entry still points to human/professional support, with no cloud
    call, charge, or usage-log — the privacy floor never suppresses crisis care.
    """
    user = await require_user_fresh(session, user_id)
    return unspent_resonance(
        user, care=care, private=True, private_message=INTIMATE_PRIVATE_MESSAGE
    )


async def care_only_response(
    session: AsyncSession, user_id: int, care: CareResponse
) -> ResonanceResponse:
    """Care surface with no reflection, for the paths that reach care instead of one.

    Used when an elevated entry's LLM pass fails, when a connected vault
    answers with its care escalation, and when a vault-bound entry is flagged
    locally and so asks no model at all. Every time, the marginalia charge has
    already been settled — by a compensating credit when BotMason paid, or
    with no wallet work for BYOK — so the fresh read below reports unchanged
    balances. We surface the human + professional pointers regardless, because
    care must never depend on the reflection succeeding (NORTH-STAR §10).
    """
    user = await require_user_fresh(session, user_id)
    return unspent_resonance(user, care=care)


async def care_or_refusal(
    session: AsyncSession, user_id: int, message: str, refusal: HTTPException
) -> ResonanceResponse:
    """Answer a payer-refused pass with care when the local screen flags the entry.

    Care never depends on the payer (NORTH-STAR §10): a refused distressed
    writer gets the care surface with no reflection -- the 200 the client
    already renders -- and anyone else gets the 402 itself (#3096).
    """
    care = care_for(message)
    if care is None:
        raise refusal
    return await care_only_response(session, user_id, care_surface(care))
