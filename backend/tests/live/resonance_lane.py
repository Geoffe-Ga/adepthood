"""Pure configuration and failure guards for the live resonance-yield lane.

The paid test module keeps all environment and exception decisions here so the
ordinary suite can prove them without a key or a network.  Merely exporting an
LLM key never arms the lane.  Once explicitly armed, a missing/mismatched
provider configuration is an error; only a provider transport condition that
carries no quality verdict may skip.
"""

from __future__ import annotations

from collections.abc import Mapping

import anthropic
import httpx
import httpx2
import openai

from services.botmason import (
    PROVIDER_REGISTRY,
    LLMCreditExhaustedError,
    validate_llm_api_key_format,
)

#: Set truthy to authorize the paid, networked resonance measurement.
OPT_IN_ENV = "LIVE_RESONANCE_CHECK"

#: Existing production provider selector exercised by the live lane.
PROVIDER_ENV = "BOTMASON_PROVIDER"

#: Existing production server-side provider credential exercised by the lane.
KEY_ENV = "LLM_API_KEY"

_FALSEY = frozenset({"", "0", "false", "no", "off"})
_TRANSIENT_STATUSES = frozenset({408, 409, 429})
_SERVER_ERROR_FLOOR = 500
_NETWORK_FAILURES: tuple[type[BaseException], ...] = (
    OSError,
    anthropic.APIConnectionError,
    openai.APIConnectionError,
    httpx.TransportError,
    httpx2.TransportError,
)


class ResonanceLaneMisconfiguredError(RuntimeError):
    """The explicitly armed lane cannot make its configured provider call."""


def _is_truthy(value: str) -> bool:
    """Return whether an environment value reads as an explicit opt-in."""
    return value.strip().casefold() not in _FALSEY


def resolve_live_resonance_api_key(env: Mapping[str, str]) -> str | None:
    """Return the armed production key, or ``None`` when the lane is off.

    The provider is validated alongside the key because passing a key directly
    to ``BotmasonResonanceLLM`` derives a provider from its prefix.  Without
    this check, a typo in ``BOTMASON_PROVIDER`` could appear to work while the
    live test silently exercised a different production configuration.

    Args:
        env: Explicit environment mapping; process state is never read here.

    Returns:
        The configured API key when explicitly armed, otherwise ``None``.

    Raises:
        ResonanceLaneMisconfiguredError: The lane is armed without a supported
            real provider and matching nonblank key.
    """
    if not _is_truthy(env.get(OPT_IN_ENV, "")):
        return None

    provider = env.get(PROVIDER_ENV, "stub")
    api_key = env.get(KEY_ENV, "")
    if provider not in PROVIDER_REGISTRY or not validate_llm_api_key_format(api_key, provider):
        message = (
            f"{OPT_IN_ENV} is truthy, but {PROVIDER_ENV} and {KEY_ENV} do not "
            "name a supported real provider with a matching nonblank key. "
            "The paid live lane fails rather than skipping a configuration "
            "that could never produce a measurement."
        )
        raise ResonanceLaneMisconfiguredError(message)
    return api_key


def _status_code(exc: BaseException) -> int | None:
    """Return a provider status directly or from its response object."""
    direct = getattr(exc, "status_code", None)
    if isinstance(direct, int):
        return direct
    response = getattr(exc, "response", None)
    nested = getattr(response, "status_code", None)
    return nested if isinstance(nested, int) else None


def provider_is_unreachable(exc: BaseException) -> bool:
    """Return whether ``exc`` is transport-only and therefore skippable.

    BotMason normalizes SDK errors to a public ``LLMProviderError`` while
    retaining the raw SDK exception as ``__cause__``.  Walk that chain without
    matching prose: connection errors, timeouts, rate limits and server errors
    yield no quality verdict.  Credential/request errors remain failures.
    Exhausted credit is also a loud failure even when a provider encodes it as
    HTTP 429, because waiting cannot make that account usable.
    """
    current: BaseException | None = exc
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, LLMCreditExhaustedError):
            return False
        if isinstance(current, _NETWORK_FAILURES):
            return True
        status = _status_code(current)
        if status is not None:
            return status in _TRANSIENT_STATUSES or status >= _SERVER_ERROR_FLOOR
        current = current.__cause__ or current.__context__
    return False
