"""What changes when adepthood declares Creek contract 0.22 rather than 0.21.

0.22 (Creek-Vault#1968) publishes one capability and nothing else:
``agent-activity``, ``GET /v1/agent-activity``, the content-free projection of
the vault's MCP audit chain that Settings reads for "Recent activity" (#3535).
Every other document in the bundle is byte-identical to 0.21 apart from the
handshake, which lists the new capability and widens its window to 0.22.

So the move is pinned on three facts: adepthood declares 0.22 on every
versioned call, a vault re-imaged to Creek ``main`` negotiates and advertises
the new capability, and a vault whose window stops at 0.21 is refused as
version skew rather than called. Creek refuses any minor it does not list
exactly, which is why that last case is ``incompatible_version`` and not an
outage: the remedy is a re-image, not a retry.

Every expectation is a literal rather than a value derived from
:data:`~domain.creek_vault.CONTRACT_VERSION`, for the reason
``tests/test_creek_contract_0_21.py`` gives: a test that reads the pin to decide
what the pin should be passes whatever the pin is.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from http import HTTPStatus
from pathlib import Path
from typing import Final, cast

import httpx
import pytest

from domain.creek_vault import CreekCapability, HandshakeResult, VaultTierCeiling
from services.creek_vault_client import HandshakeDegradeReason, HttpCreekVaultClient

_EXAMPLES: Final = Path(__file__).parent / "fixtures" / "creek_v1" / "examples"
_VAULT_URL: Final = "https://vault.example.test"
_API_KEY: Final = "contract-022-test-key"  # pragma: allowlist secret
_CONTENT: Final = "SENTINEL_022_ENTRY a quiet morning by the window."

_CAPABILITIES_PATH: Final = "/v1/capabilities"
_REFLECTIONS_PATH: Final = "/v1/reflections"
_CONTRACT_HEADER: Final = "X-Creek-Contract-Version"

#: The minor adepthood must declare. A literal, never read from the pin.
_DECLARED_MINOR: Final = "0.22"

#: The newest minors a vault still on the 0.21 image serves.
_PRE_022_WINDOW: Final = ("0.21", "0.20", "0.19")

#: The one capability 0.22 adds, under its published wire name.
_AGENT_ACTIVITY_WIRE_NAME: Final = "agent-activity"


def _example(capability: str, state: str) -> dict[str, object]:
    """Return one published example cell from the vendored bundle."""
    document = json.loads((_EXAMPLES / capability / state).read_bytes())
    assert isinstance(document, dict)
    return document


def _published_handshake() -> dict[str, object]:
    """Return Creek's own 0.22 ``capabilities/success`` document."""
    return _example("capabilities", "success.json")


def _handshake_serving(window: tuple[str, ...]) -> dict[str, object]:
    """Return the published handshake, narrowed to serve exactly *window*."""
    return _published_handshake() | {
        "contract_minor": window[0],
        "contract_version": f"{window[0]}.0",
        "supported_contract_minors": list(window),
    }


class _ScriptedVault:
    """Serve one handshake, then answer every other call with one scripted reply."""

    def __init__(
        self,
        *,
        handshake: Mapping[str, object] | None = None,
        body: Mapping[str, object] | None = None,
    ) -> None:
        """Script the handshake and the reply every capability call receives."""
        self.handshake = _published_handshake() if handshake is None else dict(handshake)
        self.body = {} if body is None else dict(body)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record *request* and answer it."""
        self.requests.append(request)
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(HTTPStatus.OK, json=self.handshake)
        return httpx.Response(HTTPStatus.OK, json=self.body)

    def calls_to(self, path: str) -> list[httpx.Request]:
        """Return every recorded request to *path*."""
        return [request for request in self.requests if request.url.path == path]


def _client(vault: _ScriptedVault) -> HttpCreekVaultClient:
    """Return a client whose only transport is *vault*."""
    return HttpCreekVaultClient(
        _VAULT_URL,
        _API_KEY,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(vault)),
    )


@pytest.mark.asyncio
async def test_a_versioned_call_declares_contract_0_22() -> None:
    """The header Creek keys every minor gate on carries 0.22 now, on every route."""
    vault = _ScriptedVault(body=_example("reflections", "success.json"))
    client = _client(vault)
    await client.handshake()

    await client.reflect(_CONTENT, VaultTierCeiling.PERSONAL)

    (sent,) = vault.calls_to(_REFLECTIONS_PATH)
    assert sent.headers[_CONTRACT_HEADER] == _DECLARED_MINOR


@pytest.mark.asyncio
async def test_the_re_imaged_vaults_window_negotiates_and_advertises_agent_activity() -> None:
    """Creek ``main``'s own published handshake (0.2 through 0.22) serves us, with the new name."""
    published = _published_handshake()
    assert _DECLARED_MINOR in cast("list[str]", published["supported_contract_minors"])
    assert _AGENT_ACTIVITY_WIRE_NAME in cast("list[str]", published["capabilities"])
    client = _client(_ScriptedVault(handshake=published))

    result = await client.handshake()

    assert result.available is True
    assert client.last_degrade_reason is None
    assert client.supports(CreekCapability.AGENT_ACTIVITY) is True


@pytest.mark.asyncio
async def test_a_vault_that_stops_at_0_21_is_an_incompatible_version() -> None:
    """The #1888 shape again: a vault not yet re-imaged cannot serve a 0.22 caller."""
    client = _client(_ScriptedVault(handshake=_handshake_serving(_PRE_022_WINDOW)))

    assert await client.handshake() == HandshakeResult.unavailable()
    assert client.last_degrade_reason is HandshakeDegradeReason.INCOMPATIBLE_VERSION


@pytest.mark.asyncio
async def test_a_vault_that_does_not_advertise_agent_activity_supports_nothing_new() -> None:
    """Naming the capability is the vault's claim to make, never adepthood's assumption."""
    published = _published_handshake()
    without = [
        name
        for name in cast("list[str]", published["capabilities"])
        if name != _AGENT_ACTIVITY_WIRE_NAME
    ]
    client = _client(_ScriptedVault(handshake=published | {"capabilities": without}))

    await client.handshake()

    assert client.supports(CreekCapability.AGENT_ACTIVITY) is False
