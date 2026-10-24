"""``HttpCreekVaultClient.agent_activity``: Creek's 0.22 ``agent-activity`` read (#3535).

Driven by the vendored bundle's own ``agent-activity`` column, so every answer
the adapter is asked to read is one Creek publishes, and by hand-built
variations of the success cell for the refusals: an answer carrying anything
outside the four published fields per row is refused whole, never trimmed,
which is the half of the content-free promise this adapter owns (the route's
re-projection, in ``tests/routers/test_vault_agent_activity.py``, is the other).
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import UTC, datetime
from http import HTTPStatus
from pathlib import Path
from typing import Final

import httpx
import pytest

from domain.creek_vault import (
    AGENT_ACTIVITY_MAX_LIMIT,
    CreekCapabilityUnsupportedError,
    CreekVaultAuthError,
    CreekVaultContractError,
    CreekVaultPayloadError,
    CreekVaultUnavailableError,
    VaultAgentActivity,
    VaultAgentActivityOutcome,
    VaultAgentActivityRow,
    VaultErrorCode,
)
from services.creek_vault_activity_wire import (
    AGENT_ACTIVITY_MIN_LIMIT,
    AGENT_ACTIVITY_PATH,
    CONSUMER_MAX_LENGTH,
    CONSUMER_PATTERN,
    TOOL_MAX_LENGTH,
    TOOL_PATTERN,
    agent_activity_from,
)
from services.creek_vault_client import HttpCreekVaultClient, LocalFallbackCreekVaultClient

_BUNDLE: Final = Path(__file__).parent / "fixtures" / "creek_v1"
_VAULT_URL: Final = "https://vault.example.test"
_API_KEY: Final = "agent-activity-test-key"  # pragma: allowlist secret
_CAPABILITIES_PATH: Final = "/v1/capabilities"
_CONTRACT_HEADER: Final = "x-creek-contract-version"
_CEILING_HEADER: Final = "x-creek-tier-ceiling"
_LIMIT: Final = 20

#: A phrase no row may ever carry onward: the shape of an argument summary.
_PROSE: Final = "SENTINEL_ACTIVITY_PROSE draft me an essay on the long way home"


def _read(relative: str) -> dict[str, object]:
    """Return one vendored JSON document."""
    document = json.loads((_BUNDLE / relative).read_bytes())
    assert isinstance(document, dict)
    return document


def _cell(state: str) -> dict[str, object]:
    """Return one published ``agent-activity`` example cell."""
    return _read(f"examples/agent-activity/{state}.json")


def _success_rows() -> list[dict[str, object]]:
    """Return the published success cell's rows, as a mutable copy."""
    rows = _cell("success")["rows"]
    assert isinstance(rows, list)
    return [dict(row) for row in rows]


class _Vault:
    """Serve the published 0.22 handshake, then one scripted ``agent-activity`` answer."""

    def __init__(self, *, status: int = HTTPStatus.OK, body: object = None) -> None:
        """Script the answer the activity route receives."""
        self.status = status
        self.body: object = _cell("success") if body is None else body
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record *request* and answer it."""
        self.requests.append(request)
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(HTTPStatus.OK, json=_read("examples/capabilities/success.json"))
        if isinstance(self.body, bytes):
            return httpx.Response(self.status, content=self.body)
        return httpx.Response(self.status, json=self.body)

    def activity_calls(self) -> list[httpx.Request]:
        """Every request that reached the activity route."""
        return [r for r in self.requests if r.url.path == AGENT_ACTIVITY_PATH]


async def _handshaken(vault: _Vault) -> HttpCreekVaultClient:
    """Return a client over *vault* that has already negotiated."""
    client = HttpCreekVaultClient(
        _VAULT_URL,
        _API_KEY,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(vault)),
    )
    await client.handshake()
    return client


# --- the request -----------------------------------------------------------


@pytest.mark.asyncio
async def test_the_read_is_a_bare_get_with_only_a_limit() -> None:
    """One ``GET``, no body, the 0.22 header, the content-free ceiling, and ``limit`` alone."""
    vault = _Vault()
    client = await _handshaken(vault)

    await client.agent_activity(_LIMIT)

    (sent,) = vault.activity_calls()
    assert sent.method == "GET"
    assert sent.content == b""
    assert dict(sent.url.params) == {"limit": str(_LIMIT)}
    assert sent.headers[_CONTRACT_HEADER] == "0.22"
    assert sent.headers[_CEILING_HEADER] == "open"


@pytest.mark.asyncio
async def test_an_unadvertised_capability_puts_nothing_on_the_wire() -> None:
    """A vault that never offered the read is refused locally, before any request."""
    vault = _Vault()
    client = HttpCreekVaultClient(
        _VAULT_URL,
        _API_KEY,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(vault)),
    )

    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.agent_activity(_LIMIT)

    assert vault.requests == []


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", [0, -1, AGENT_ACTIVITY_MAX_LIMIT + 1])
async def test_a_limit_outside_the_published_bounds_is_refused_before_the_wire(
    limit: int,
) -> None:
    """Creek answers ``invalid_request`` below one; adepthood never asks it to."""
    vault = _Vault()
    client = await _handshaken(vault)

    with pytest.raises(ValueError, match="limit"):
        await client.agent_activity(limit)

    assert vault.activity_calls() == []


@pytest.mark.asyncio
async def test_the_local_fallback_has_no_activity_to_read() -> None:
    """No vault, no audit chain: the fallback refuses as unsupported."""
    with pytest.raises(CreekCapabilityUnsupportedError):
        await LocalFallbackCreekVaultClient().agent_activity(_LIMIT)


# --- the published answers -------------------------------------------------


@pytest.mark.asyncio
async def test_the_success_cell_reads_back_row_for_row() -> None:
    """Creek's published success cell, newest first, each row exactly its four fields."""
    client = await _handshaken(_Vault())

    activity = await client.agent_activity(_LIMIT)

    assert activity == VaultAgentActivity(
        rows=(
            VaultAgentActivityRow(
                consumer="acct_91",
                tool="creek.draft",
                at=datetime(2026, 10, 24, 18, 2, 11, tzinfo=UTC),
                outcome=VaultAgentActivityOutcome.ADMITTED,
            ),
            VaultAgentActivityRow(
                consumer="acct_91",
                tool="creek.link",
                at=datetime(2026, 10, 24, 18, 1, 50, tzinfo=UTC),
                outcome=VaultAgentActivityOutcome.REFUSED,
            ),
            VaultAgentActivityRow(
                consumer="adepthood",
                tool="creek.journal",
                at=datetime(2026, 10, 24, 17, 40, 3, tzinfo=UTC),
                outcome=VaultAgentActivityOutcome.ADMITTED,
            ),
        )
    )


@pytest.mark.asyncio
async def test_the_empty_cell_is_an_empty_list_not_a_failure() -> None:
    """An absent or empty log is ``rows: []``, which is an answer."""
    client = await _handshaken(_Vault(body=_cell("empty")))

    assert await client.agent_activity(_LIMIT) == VaultAgentActivity(rows=())


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("state", "status", "expected", "code"),
    [
        (
            "malformed-input",
            HTTPStatus.UNPROCESSABLE_ENTITY,
            CreekVaultContractError,
            VaultErrorCode.INVALID_REQUEST,
        ),
        (
            "incompatible-version",
            HTTPStatus.CONFLICT,
            CreekVaultContractError,
            VaultErrorCode.INCOMPATIBLE_VERSION,
        ),
        (
            "unavailable-service",
            HTTPStatus.SERVICE_UNAVAILABLE,
            CreekVaultUnavailableError,
            VaultErrorCode.UNAVAILABLE,
        ),
    ],
)
async def test_each_published_error_cell_raises_its_classified_failure(
    state: str, status: int, expected: type[Exception], code: VaultErrorCode
) -> None:
    """The column's three error envelopes classify as every other read's do."""
    client = await _handshaken(_Vault(status=status, body=_cell(state)))

    with pytest.raises(expected) as raised:
        await client.agent_activity(_LIMIT)

    assert getattr(raised.value, "code", None) is code


@pytest.mark.asyncio
async def test_a_refused_credential_is_an_auth_failure() -> None:
    """An uncoded 401 is a credential to rotate, as on every other read."""
    client = await _handshaken(_Vault(status=HTTPStatus.UNAUTHORIZED, body={}))

    with pytest.raises(CreekVaultAuthError):
        await client.agent_activity(_LIMIT)


@pytest.mark.asyncio
async def test_a_transport_failure_is_an_absent_vault() -> None:
    """A connection that never lands is unavailability, with nothing chained."""

    def _refuse(request: httpx.Request) -> httpx.Response:
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(HTTPStatus.OK, json=_read("examples/capabilities/success.json"))
        raise httpx.ConnectError("refused", request=request)

    client = HttpCreekVaultClient(
        _VAULT_URL,
        _API_KEY,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(_refuse)),
    )
    await client.handshake()

    with pytest.raises(CreekVaultUnavailableError) as raised:
        await client.agent_activity(_LIMIT)

    assert raised.value.__cause__ is None


# --- the strictness that makes it content-free -----------------------------


def _with_rows(rows: list[dict[str, object]]) -> dict[str, object]:
    """Return the success cell with *rows* in place of its own."""
    return _cell("success") | {"rows": rows}


def _first_row_with(**changes: object) -> dict[str, object]:
    """Return the success cell with its first row changed."""
    rows = _success_rows()
    rows[0] = rows[0] | changes
    return _with_rows(rows)


_OFF_SCHEMA_ANSWERS: Final[Mapping[str, object]] = {
    "a fifth field on a row": _first_row_with(args_summary=_PROSE),
    "a fragment id on a row": _first_row_with(fragment_id="frag-3f9a1c7e40b2"),
    "prose on the envelope": _cell("success") | {"note": _PROSE},
    "an outcome the enum cannot name": _first_row_with(outcome="returned"),
    "a boolean outcome": _first_row_with(outcome=True),
    "a tool outside its pattern": _first_row_with(tool=_PROSE),
    "a consumer with a control character": _first_row_with(consumer="acct\n91"),
    "an empty consumer": _first_row_with(consumer=""),
    "a naive instant": _first_row_with(at="2026-10-24T18:02:11"),
    "a numeric instant": _first_row_with(at=1_761_328_931),
    "a missing field": _with_rows([{"consumer": "acct_91", "tool": "creek.draft"}]),
    "a status other than ok": _cell("success") | {"status": "partial"},
    "an intimate ceiling": _cell("success") | {"tier_ceiling": "intimate"},
    "a negative skipped count": _cell("success") | {"skipped": -1},
    "a skipped count as a string": _cell("success") | {"skipped": "0"},
    "more rows than published": _with_rows(_success_rows()[:1] * (AGENT_ACTIVITY_MAX_LIMIT + 1)),
    "a list instead of an object": _success_rows(),
}


@pytest.mark.asyncio
@pytest.mark.parametrize("label", list(_OFF_SCHEMA_ANSWERS))
async def test_an_off_schema_answer_is_refused_whole(
    label: str, caplog: pytest.LogCaptureFixture
) -> None:
    """Anything outside the published shape is a payload fault; nothing of it survives.

    The refusal carries a static message and no chained exception, because a
    validation error quotes the input it refused.
    """
    client = await _handshaken(_Vault(body=_OFF_SCHEMA_ANSWERS[label]))

    with pytest.raises(CreekVaultPayloadError) as raised:
        await client.agent_activity(_LIMIT)

    assert _PROSE not in str(raised.value)
    assert raised.value.__context__ is None
    assert raised.value.__cause__ is None
    assert _PROSE not in caplog.text


@pytest.mark.asyncio
async def test_a_body_that_is_not_json_is_a_payload_fault() -> None:
    """Bytes that do not decode are the vault answering unreadably, not an outage."""
    client = await _handshaken(_Vault(body=b"<html>" + _PROSE.encode() + b"</html>"))

    with pytest.raises(CreekVaultPayloadError):
        await client.agent_activity(_LIMIT)


def test_the_parser_admits_every_published_row_shape() -> None:
    """``<unregistered>`` is a published tool spelling; a row naming it reads back."""
    body = json.dumps(_first_row_with(tool="<unregistered>")).encode()

    parsed = agent_activity_from(body)

    assert parsed is not None
    assert parsed.rows[0].tool == "<unregistered>"


# --- the models are the published schema -----------------------------------


def _object(value: object) -> dict[str, object]:
    """Narrow one JSON value to an object, failing the test if it is not one."""
    assert isinstance(value, dict)
    return value


def test_the_strict_models_hold_the_published_bounds() -> None:
    """Every bound the parser enforces is read back from the vendored schema.

    So a re-vendor that moved a bound turns this red rather than leaving the
    adapter enforcing yesterday's contract.
    """
    response = _read("schemas/AgentActivityResponse.schema.json")
    row = _read("schemas/AgentActivityRow.schema.json")
    properties = _object(row["properties"])
    consumer = _object(properties["consumer"])
    tool = _object(properties["tool"])
    rows = _object(_object(response["properties"])["rows"])
    outcome = _object(_object(row["$defs"])["AgentActivityOutcome"])
    limit = _object(_object(_read("schemas/AgentActivityQuery.schema.json")["properties"])["limit"])

    assert response["additionalProperties"] is False
    assert row["additionalProperties"] is False
    assert response["required"] == ["status", "tier_ceiling", "skipped", "rows"]
    assert row["required"] == ["consumer", "tool", "at", "outcome"]
    assert rows["maxItems"] == AGENT_ACTIVITY_MAX_LIMIT
    assert limit["minimum"] == AGENT_ACTIVITY_MIN_LIMIT
    assert consumer["maxLength"] == CONSUMER_MAX_LENGTH
    assert consumer["pattern"] == CONSUMER_PATTERN
    assert tool["maxLength"] == TOOL_MAX_LENGTH
    assert tool["pattern"] == TOOL_PATTERN
    assert outcome["enum"] == [member.value for member in VaultAgentActivityOutcome]
