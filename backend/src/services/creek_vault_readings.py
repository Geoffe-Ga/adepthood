"""The optional 0.25 recommendation operation over the shared authorized transport."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Protocol

import httpx

from domain.creek_vault import (
    CreekCapability,
    CreekVaultError,
    CreekVaultUnavailableError,
    HandshakeResult,
    WireTierCeiling,
)
from domain.reading_recommendations import (
    ReadingRecommendation,
    ReadingRequest,
    parse_reading_recommendation,
)
from services.creek_vault_call_errors import HTTP_CALL_FAILED_ERRORS, HTTP_CALL_TIMED_OUT_ERRORS
from services.creek_vault_telemetry import (
    VaultCallTimedOutError,
    VaultTelemetryOutcome,
    record_vault_outcome,
)


class ReadingSender(Protocol):
    """The shared sender already bound to this vault, operation, and no-key policy."""

    def __call__(
        self, body: Mapping[str, object], *, ceiling: WireTierCeiling
    ) -> Awaitable[httpx.Response]:
        """Send under the existing auth, suspension, destination, and deadline rules."""
        ...


def _ready(handshake: HandshakeResult) -> bool:
    return (
        handshake.available
        and handshake.keyless_inference is True
        and CreekCapability.READING_RECOMMENDATIONS in handshake.capabilities
    )


def _ceiling(request: ReadingRequest) -> WireTierCeiling:
    return (
        WireTierCeiling.PERSONAL
        if any(source.tier == "personal" for source in request.sources)
        else WireTierCeiling.OPEN
    )


async def _post(send: ReadingSender, request: ReadingRequest) -> httpx.Response:
    body = request.wire_body()
    try:
        return await send(body, ceiling=_ceiling(request))
    except HTTP_CALL_TIMED_OUT_ERRORS:
        raise VaultCallTimedOutError("reading recommendation unavailable") from None
    except HTTP_CALL_FAILED_ERRORS:
        raise CreekVaultUnavailableError("reading recommendation unavailable") from None


def _payload(response: httpx.Response) -> object:
    try:
        return response.json()
    except (ValueError, UnicodeDecodeError):
        return None


async def recommend_from_vault(
    request: ReadingRequest,
    handshake: HandshakeResult,
    send: ReadingSender,
    refusal: Callable[[CreekCapability, httpx.Response], CreekVaultError],
) -> ReadingRecommendation | None:
    """No advertisement or ready keyless model means no ambient generation."""
    if not _ready(handshake):
        return None
    response = await _post(send, request)
    capability = CreekCapability.READING_RECOMMENDATIONS
    if not response.is_success:
        raise refusal(capability, response) from None
    result = parse_reading_recommendation(_payload(response), request)
    record_vault_outcome(VaultTelemetryOutcome.SUCCESS, capability)
    return result
