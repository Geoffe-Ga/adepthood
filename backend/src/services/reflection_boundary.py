"""Which side may answer an AI operation for this caller, and what a refusal is called.

A resonance pass is several AI operations, not one: the reflection itself and
the completion detection that follows it -- and frequency classification is
another, off that route. Each used to pick its own source, and the vault-backed ones
quietly picked the app's own model provider whenever the vault said nothing or
failed. For a writer who connected a vault so their writing would be answered
from it, that is the one substitution they never chose.

:class:`ReflectionBoundary` is the decision made once per request instead, from
the server's own record of whether this caller has a vault -- never from
anything the client sends, and never from a BYOK header, which the client
attaches to every request whenever a key is stored and so says nothing about
consent to fall back:

* :attr:`ReflectionBoundary.APP_PROVIDER` -- no vault is connected. Every
  operation is answered by the app provider, exactly as before.
* :attr:`ReflectionBoundary.VAULT_BOUND` -- the caller has a vault connection
  (including one that is provisioned but not ready yet, or whose stored host is
  currently undialable), or is the bound owner of the deployment-wide vault.
  Every operation is answered by the vault or not at all. There is no fallback,
  and nothing here can grant one.

This is a narrowing of where writing may be sent. It says nothing about where a
vault itself sends it: a vault may route work to its own models, local or not,
and that is the vault's boundary to declare, not this module's to promise.

:func:`app_provider_llm` is the only place in the reflection and detection
routes that constructs the app-provider adapter, so the boundary is enforced by
construction rather than by each call site remembering to check it.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Final

from services.marginalia import BotmasonResonanceLLM

#: The stable error token a vault-bound operation answers when its vault could
#: not. Neutral on purpose: it names what failed to happen, not where.
REFLECTION_SOURCE_UNAVAILABLE: Final[str] = "reflection_source_unavailable"


class ReflectionBoundary(StrEnum):
    """Which side may answer this caller's AI operations, resolved server-side per request."""

    APP_PROVIDER = "app_provider"
    VAULT_BOUND = "vault_bound"


class VaultSourceUnavailableReason(StrEnum):
    """Why a vault-bound operation got no answer, in a closed vocabulary safe to log.

    Every member is this module's own word. None carries anything the vault
    said, the body, a prompt, or a key, so a record built from one can be read
    by an operator without reading anyone's writing.
    """

    #: The vault did not answer its handshake as available.
    UNAVAILABLE = "unavailable"
    #: The vault answered, but never advertised the capability this operation needs.
    CAPABILITY_MISSING = "capability_missing"
    #: The entry's classification maps to no tier the vault may be asked at.
    UNKNOWN_TIER = "unknown_tier"
    #: The call itself failed (refused, unreadable, credential, transport, timeout).
    VAULT_ERROR = "vault_error"
    #: The vault gave this operation no usable answer. Any fault behind that is
    #: recorded by the read-degrade log with its own reason; this word says only
    #: that the operation was refused rather than answered elsewhere.
    NO_ANSWER = "no_answer"


class VaultSourceUnavailableError(Exception):
    """A vault-bound operation could not be answered by the vault, and will not be answered at all.

    Deliberately *not* an :class:`~services.botmason.LLMProviderError`: the
    router's provider-failure arms answer a 502 and, for a distress-flagged
    entry, swallow into care, and neither is what this is. A writer whose vault
    is down gets a retryable "unavailable" and a refund, not an upstream-model
    error.
    """

    def __init__(self, reason: VaultSourceUnavailableReason) -> None:
        """Record the closed-vocabulary reason; the message is the static token."""
        super().__init__(REFLECTION_SOURCE_UNAVAILABLE)
        self.reason = reason


class AppProviderRefusedError(RuntimeError):
    """Raised when code asks for the app provider under :attr:`ReflectionBoundary.VAULT_BOUND`.

    A defect at the call site, never a runtime condition: every route checks the
    boundary before it reaches for the app provider. Raising rather than
    returning something is what keeps a forgotten check a 500 instead of a
    silent dial.
    """

    def __init__(self) -> None:
        """Carry a static message naming the refusal, nothing about the caller."""
        super().__init__("app provider refused under a vault-bound boundary")


def app_provider_llm(
    boundary: ReflectionBoundary, api_key: str | None
) -> BotmasonResonanceLLM | None:
    """Return the app-provider adapter, or ``None`` when the boundary forbids it.

    ``None`` under :attr:`ReflectionBoundary.VAULT_BOUND` whatever ``api_key``
    is: a BYOK key pays for a call, it does not consent to one.
    """
    if boundary is ReflectionBoundary.VAULT_BOUND:
        return None
    return BotmasonResonanceLLM(api_key)


def require_app_provider_llm(
    boundary: ReflectionBoundary, api_key: str | None
) -> BotmasonResonanceLLM:
    """Return the app-provider adapter for a caller already known to be app-provider bound.

    For call sites that branch on the boundary before they get here. Raises
    :class:`AppProviderRefusedError` rather than returning ``None``, so a call
    site whose own check was removed fails loudly instead of dialling.
    """
    llm = app_provider_llm(boundary, api_key)
    if llm is None:
        raise AppProviderRefusedError
    return llm
