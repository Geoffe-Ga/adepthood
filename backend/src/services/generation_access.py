"""Refuse a generation that nobody can pay for, before anything is spent (#3096).

The owner's decision (b07-e4, 2026-10-07): no AI feature may generate anything
at all unless the account has BotMason credits available or has configured its
own OpenAI or Anthropic key. Before this, a deployment with no real provider
answered every request with the canned stub -- a couple of text-replaced
sentences, presented as a reflection, letter or page.

:func:`require_ai_payer` is that rule, applied once at each AI route's admission,
directly after :func:`services.privacy_suspension.require_external_ai_available`
and for the same reason: after the route's free exits (a cached letter, an
intimate entry's care surface, a vault-bound caller's skipped detection), and
before the minute bucket, the concurrent slot, the wallet or any dial. So a
refusal is free: no wallet change, no audit row, no slot, no usage row.

A refusal reuses the 402 details the client already routes to its "add credits
or a key" surface, so this adds no parallel shape:

* ``llm_key_required`` -- no personal key, and the request would be answered by
  the app's provider. Only a key of the writer's own can answer it.
* ``insufficient_offerings`` -- no personal key, and neither wallet bucket has a
  unit left.

One refusal is not a payer question and is a 403 instead: ``ai_access_revoked``,
for an account whose latest revocation was a refund, a dispute, the end of a
membership's paid period (#3259 -- never the cancel click itself) or an
operator's revocation, and which was not re-granted (#1938, B21 E1). It is
decided by :func:`domain.entitlements.refuse_if_ai_access_revoked` after the
key check, so a personal key is still admitted, and before the wallet is read,
so the client is never offered a refill that could not help.

ADR 0009 phase (a) (#3067): the server's ``LLM_API_KEY`` never pays for a
request carrying a person's content, so credits buy nothing on the app-provider
path. :func:`services.botmason.server_generation_available` is the one predicate
that says so -- true only for the armed stub test seam -- and this gate's
``llm_key_required`` arm covers every keyless app-provider request. Credits pay
only when the caller's vault answers (``app_provider=False``); whether the vault
itself uses a cloud model is the vault's boundary (``CREEK_DOWNSTREAM_MODEL``,
under the Creek deployment's ``CREEK_CLOUD_CONSENT``), and is not yet verified
per receipt -- a known gap escalated to the owner (ADR 0009 Decision item 4).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from fastapi import HTTPException, status

from domain.entitlements import AI_ACCESS_REVOKED, refuse_if_ai_access_revoked
from errors import payment_required
from services.account_egress_barrier import ensure_account_live
from services.botmason import (
    KEY_REQUIRED_DETAIL,
    resolve_chat_api_key,
    server_generation_available,
)
from services.wallet import has_generation_capacity

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

#: 402: no personal key, and nothing on the server that credits could buy.
KEY_REQUIRED: Final = KEY_REQUIRED_DETAIL
#: 402: no personal key, and no credits left in either wallet bucket. The same
#: detail :func:`services.wallet.preflight_deduction` refuses an empty wallet with.
CREDITS_OR_KEY_REQUIRED: Final = "insufficient_offerings"


async def require_ai_payer(
    session: AsyncSession,
    user_id: int,
    supplied_key: str | None,
    *,
    app_provider: bool = True,
) -> None:
    """Admit a generation only when a personal key or BotMason credits can pay for it.

    ``supplied_key`` is the raw ``X-LLM-API-Key`` header: a well-formed key is a
    payer by itself (a malformed one is the usual 400). Without one the request
    needs credits, and -- when ``app_provider`` says the app's own provider
    would answer rather than the caller's vault -- is refused, because no cloud
    model answers a person's content without their own key (only the armed
    stub test seam is admitted). A request credits would pay for is refused
    ``403 ai_access_revoked`` when the account's entitlement was revoked
    (#1938, B21 E1); a personal key is admitted whatever the entitlement, since
    it funds nothing of the operator's. Reads only; spends nothing.
    """
    if resolve_chat_api_key(supplied_key) is not None:
        return
    if app_provider and not server_generation_available():
        raise payment_required(KEY_REQUIRED)
    # An account erased while this request was in flight is answered with the
    # same 401 its egress barrier would give, not a wallet question.
    await ensure_account_live(session, user_id)
    # A revoked entitlement is answered before the wallet is read: credits are
    # not what is missing, so a 402 would offer a refill that cannot help.
    await refuse_if_ai_access_revoked(session, user_id)
    if not await has_generation_capacity(session, user_id):
        raise payment_required(CREDITS_OR_KEY_REQUIRED)


async def payer_refusal(
    session: AsyncSession,
    user_id: int,
    supplied_key: str | None,
    *,
    app_provider: bool = True,
) -> HTTPException | None:
    """Run :func:`require_ai_payer`, handing back its refusal instead of raising it.

    For a route that owes the writer something even when nobody can pay -- the
    resonance pass's local care surface. Hands back a 402 payer refusal and the
    403 ``ai_access_revoked``, since care depends on neither. ``None`` means
    admitted; any other refusal (a malformed key, an erased account) still
    raises.
    """
    try:
        await require_ai_payer(session, user_id, supplied_key, app_provider=app_provider)
    except HTTPException as refusal:
        if not _is_payer_refusal(refusal):
            raise
        return refusal
    return None


def _is_payer_refusal(refusal: HTTPException) -> bool:
    """Whether ``refusal`` is one :func:`payer_refusal` hands back rather than raises."""
    if refusal.status_code == status.HTTP_402_PAYMENT_REQUIRED:
        return True
    return refusal.status_code == status.HTTP_403_FORBIDDEN and refusal.detail == AI_ACCESS_REVOKED
