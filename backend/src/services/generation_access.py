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

* ``llm_key_required`` -- no personal key, and the server has nothing credits
  could buy (a ``stub`` deployment without the test seam, or a real provider
  with no server key). Only a key of the writer's own can answer.
* ``insufficient_offerings`` -- no personal key, and neither wallet bucket has a
  unit left.

What this does **not** change: the server's ``LLM_API_KEY`` still pays for a
credit-funded request on a real provider. Removing that app-key fallback for
anything carrying a person's content is ADR 0009 phase (a); when it lands,
:func:`services.botmason.server_generation_available` is the one predicate that
narrows, and this gate's ``llm_key_required`` arm then covers it unchanged.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from fastapi import HTTPException, status

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
    would answer rather than the caller's vault -- a server able to answer at
    all. Reads only; spends nothing.
    """
    if resolve_chat_api_key(supplied_key) is not None:
        return
    if app_provider and not server_generation_available():
        raise payment_required(KEY_REQUIRED)
    # An account erased while this request was in flight is answered with the
    # same 401 its egress barrier would give, not a wallet question.
    await ensure_account_live(session, user_id)
    if not await has_generation_capacity(session, user_id):
        raise payment_required(CREDITS_OR_KEY_REQUIRED)


async def payer_refusal(
    session: AsyncSession,
    user_id: int,
    supplied_key: str | None,
    *,
    app_provider: bool = True,
) -> HTTPException | None:
    """Run :func:`require_ai_payer`, handing back its 402 instead of raising it.

    For a route that owes the writer something even when nobody can pay -- the
    resonance pass's local care surface. ``None`` means admitted; any other
    refusal (a malformed key, an erased account) still raises.
    """
    try:
        await require_ai_payer(session, user_id, supplied_key, app_provider=app_provider)
    except HTTPException as refusal:
        if refusal.status_code != status.HTTP_402_PAYMENT_REQUIRED:
            raise
        return refusal
    return None
