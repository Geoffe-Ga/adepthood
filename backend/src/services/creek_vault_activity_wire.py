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

from datetime import UTC
from typing import Annotated, Final, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError

from domain.creek_vault import (
    AGENT_ACTIVITY_MAX_LIMIT,
    CreekCapability,
    VaultAgentActivity,
    VaultAgentActivityOutcome,
    VaultAgentActivityRow,
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
