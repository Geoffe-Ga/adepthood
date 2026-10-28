"""The wire half of Creek's ``agent-activity`` read (contract 0.22, Creek-Vault#1968).

``GET /v1/agent-activity`` answers the vault's MCP audit chain projected onto
four fields per call -- ``consumer``, ``tool``, ``at`` and ``outcome`` -- under
an envelope of ``status``, ``tier_ceiling`` and ``skipped``. This module holds
the request path, the static messages the adapter raises with, and the one
parser that turns an answer into :class:`~domain.creek_vault.VaultAgentActivity`.

**Strict, and all-or-nothing.** The models below mirror the published
``AgentActivityResponse`` schema field for field and forbid anything else: a
fifth field on a row, a field on the envelope Creek never published, an
``outcome`` outside the closed enum, a ``tool`` or ``consumer`` outside its
published pattern, a naive ``at``, or more rows than the published
``maxItems`` each refuse the *whole* answer. Nothing is copied and then
scrubbed, so there is no scrub to forget: a field this module never names
cannot reach a caller, and a vault that started sending one is a payload fault
an operator can see rather than a leak nobody can.

Extra fields are refused rather than ignored for a reason specific to this
read. Every other ``/v1`` answer adepthood parses carries the writer's own
material by design; this one is promised to carry none, and the promise is only
checkable if a field outside the four is treated as a broken promise. The pin
makes that safe: adepthood declares the minor it speaks, so a vault adding a
field at a later minor does not send it to a 0.22 caller.

``tests/test_creek_vault_agent_activity.py`` holds these models to the vendored
schema, so the bounds below are the published ones rather than a copy that can
drift.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import UTC
from typing import Annotated, Final, Literal, Protocol
from urllib.parse import urlencode

import httpx
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError

from domain.creek_vault import (
    AGENT_ACTIVITY_MAX_LIMIT,
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultError,
    CreekVaultPayloadError,
    CreekVaultUnavailableError,
    VaultAgentActivity,
    VaultAgentActivityOutcome,
    VaultAgentActivityRow,
    WireTierCeiling,
)
from services.creek_vault_call_errors import HTTP_CALL_FAILED_ERRORS, HTTP_CALL_TIMED_OUT_ERRORS
from services.creek_vault_telemetry import (
    VaultCallTimedOutError,
    VaultTelemetryOutcome,
    record_vault_outcome,
)

#: Where the read is asked for, relative to the configured base URL.
AGENT_ACTIVITY_PATH: Final = "/v1/agent-activity"

#: The fewest rows a request may ask for: the published query's ``minimum``.
AGENT_ACTIVITY_MIN_LIMIT: Final = 1

#: The one query parameter adepthood sends. ``since`` is published too and left
#: unsent: the Settings list asks for the newest calls, not a window.
AGENT_ACTIVITY_LIMIT_PARAM: Final = "limit"

# The static messages, built the way every other capability's are: a fixed
# prefix and the capability's own telemetry name, never anything a vault sent.
AGENT_ACTIVITY_FAILED_MESSAGE: Final = (
    f"creek vault call failed: {CreekCapability.AGENT_ACTIVITY.value}"
)
AGENT_ACTIVITY_UNSUPPORTED_MESSAGE: Final = (
    f"creek vault capability unsupported: {CreekCapability.AGENT_ACTIVITY.value}"
)
AGENT_ACTIVITY_UNREADABLE_MESSAGE: Final = (
    f"creek vault returned an unreadable response: {CreekCapability.AGENT_ACTIVITY.value}"
)

# The published bounds on a row's two identifiers (``AgentActivityRow.schema.json``).
CONSUMER_MAX_LENGTH: Final = 256
CONSUMER_PATTERN: Final = "^[^\x00-\x1f\x7f]+$"
TOOL_MAX_LENGTH: Final = 128
TOOL_PATTERN: Final = r"^(?:[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*|<unregistered>)$"

_CLOSED: Final = ConfigDict(extra="forbid", strict=True, frozen=True)


class _WireRow(BaseModel):
    """``AgentActivityRow``: four fields, and never a fifth."""

    model_config = _CLOSED

    consumer: Annotated[
        str, Field(min_length=1, max_length=CONSUMER_MAX_LENGTH, pattern=CONSUMER_PATTERN)
    ]
    tool: Annotated[str, Field(max_length=TOOL_MAX_LENGTH, pattern=TOOL_PATTERN)]
    at: AwareDatetime
    outcome: VaultAgentActivityOutcome


class _WireResponse(BaseModel):
    """``AgentActivityResponse``: the envelope, closed like every wire model."""

    model_config = _CLOSED

    status: Literal["ok"]
    tier_ceiling: Literal["open", "personal"]
    skipped: Annotated[int, Field(ge=0)]
    rows: Annotated[list[_WireRow], Field(max_length=AGENT_ACTIVITY_MAX_LIMIT)]


def _validated(body: bytes) -> _WireResponse | None:
    """Validate one answer's raw bytes, or ``None`` when they are not the published shape.

    ``None`` rather than a raise, so the caller's refusal is raised *outside*
    this ``except``: a :class:`~pydantic.ValidationError` quotes the input it
    refused, and an exception raised inside the handler would carry that quote
    as its ``__context__`` into every traceback that renders it.
    """
    try:
        return _WireResponse.model_validate_json(body)
    except ValidationError:
        return None


def agent_activity_from(body: bytes) -> VaultAgentActivity | None:
    """Project a successful answer onto the domain value, or ``None`` if it is unreadable.

    Validated from the raw JSON bytes rather than from a decoded mapping,
    because strict validation of JSON is what admits an ISO 8601 ``at`` while
    still refusing a number where a string belongs.
    """
    response = _validated(body)
    if response is None:
        return None
    return VaultAgentActivity(
        rows=tuple(
            VaultAgentActivityRow(
                consumer=row.consumer,
                tool=row.tool,
                at=row.at.astimezone(UTC),
                outcome=row.outcome,
            )
            for row in response.rows
        )
    )


# Static, and naming the bound rather than the value: a limit is a caller's
# integer, but nothing about a refusal should echo what was passed.
_LIMIT_MESSAGE: Final = (
    f"agent activity limit must be between {AGENT_ACTIVITY_MIN_LIMIT} "
    f"and {AGENT_ACTIVITY_MAX_LIMIT}"
)


def agent_activity_path(limit: int) -> str:
    """The request path and query for ``limit`` rows, refusing a limit Creek would.

    Checked before anything else, so a caller's bug is a ``ValueError`` here
    rather than an ``invalid_request`` the vault would have to answer.

    Raises:
        ValueError: When ``limit`` is outside the published ``1..200``.
    """
    if not AGENT_ACTIVITY_MIN_LIMIT <= limit <= AGENT_ACTIVITY_MAX_LIMIT:
        raise ValueError(_LIMIT_MESSAGE)
    return f"{AGENT_ACTIVITY_PATH}?{urlencode({AGENT_ACTIVITY_LIMIT_PARAM: limit})}"


def agent_activity_answer(
    response: httpx.Response,
    read_failure: Callable[[CreekCapability, httpx.Response], CreekVaultError],
) -> VaultAgentActivity:
    """Read one answer, or raise the failure it is.

    A non-2xx is classified by ``read_failure`` -- the adapter's one read
    classifier, code first and status second -- and a 2xx that is not exactly
    the published shape is a :class:`CreekVaultPayloadError` with a static
    message and nothing chained, so no part of an off-schema answer rides it.

    Raises:
        CreekVaultError: The classified failure for any answer that is not a
            readable success.
    """
    if not response.is_success:
        raise read_failure(CreekCapability.AGENT_ACTIVITY, response) from None
    activity = agent_activity_from(response.content)
    if activity is None:
        raise CreekVaultPayloadError(AGENT_ACTIVITY_UNREADABLE_MESSAGE)
    return activity


class ReadTransport(Protocol):
    """The adapter's one authorized, deadlined way onto the wire."""

    def __call__(
        self, method: str, url: str, /, *, ceiling: WireTierCeiling
    ) -> Awaitable[httpx.Response]:
        """Send one request at ``ceiling`` and return the vault's answer."""


#: The adapter's read classifier for a non-2xx answer.
ReadFailure = Callable[[CreekCapability, httpx.Response], CreekVaultError]


async def _get(send: ReadTransport, url: str) -> httpx.Response:
    """``GET`` ``url`` at the content-free ceiling, normalizing any transport failure.

    Declared at ``open`` because the route reads no content and Creek echoes
    the ceiling without filtering on it. A call that ran out of time is
    :class:`VaultCallTimedOutError`, any other that did not land
    :class:`CreekVaultUnavailableError`; both carry only the static message
    and are raised ``from None``, so the original exception's text neither
    rides along nor is chained. The timeout set is named first because it sits
    inside the wider one.
    """
    try:
        return await send("GET", url, ceiling=WireTierCeiling.OPEN)
    except HTTP_CALL_TIMED_OUT_ERRORS:
        raise VaultCallTimedOutError(AGENT_ACTIVITY_FAILED_MESSAGE) from None
    except HTTP_CALL_FAILED_ERRORS:
        raise CreekVaultUnavailableError(AGENT_ACTIVITY_FAILED_MESSAGE) from None


async def read_agent_activity(
    send: ReadTransport,
    base_url: str,
    limit: int,
    *,
    supported: bool,
    read_failure: ReadFailure,
) -> VaultAgentActivity:
    """Read ``GET /v1/agent-activity`` and report how the exchange ended.

    ``limit`` is checked first, then the capability: a vault that never
    advertised the read gets no request at all. A success is counted here;
    every failure is raised, for the caller's counting wrapper.

    Raises:
        ValueError: When ``limit`` is outside the published bounds.
        CreekCapabilityUnsupportedError: When the vault did not advertise it.
        CreekVaultError: The classified failure of any other unreadable answer.
    """
    path = agent_activity_path(limit)
    if not supported:
        raise CreekCapabilityUnsupportedError(AGENT_ACTIVITY_UNSUPPORTED_MESSAGE)
    response = await _get(send, f"{base_url}{path}")
    activity = agent_activity_answer(response, read_failure)
    record_vault_outcome(VaultTelemetryOutcome.SUCCESS, CreekCapability.AGENT_ACTIVITY)
    return activity
