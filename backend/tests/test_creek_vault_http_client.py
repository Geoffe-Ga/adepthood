"""Tests for the HTTP/JSON Creek Vault adapter in services.creek_vault_client.

Every case drives the adapter through an ``httpx.MockTransport`` handler, so no
test touches a network or waits on real time. The capability payload asserted
here is the only response shape adepthood can know today -- the one it already
parses. Nothing beyond it is invented, because Creek's ratified ``/v1`` document
has not shipped.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncGenerator, Callable, Coroutine, Mapping, Sequence
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

import httpx
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from conftest import test_engine
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultClient,
    HandshakeResult,
    VaultIngestRequest,
    VaultTierCeiling,
)
from main import app, lifespan
from services.creek_vault_client import (
    _VAULT_HTTP_TIMEOUT,
    _VAULT_TIMEOUT_SECONDS,
    _VAULT_TOTAL_DEADLINE_SECONDS,
    HandshakeDegradeReason,
    HttpCreekVaultClient,
    LocalFallbackCreekVaultClient,
    McpCreekVaultClient,
    _build_pooled_vault_client,
    _contract_version_compatible,
    _VaultHttpPool,
    build_creek_vault_client,
    close_creek_vault_http_pool,
)
from services.creek_vault_write import VaultWriteStatus, store_and_classify

_VAULT_URL = "https://vault.example.test"

_CAPABILITIES_URL = f"{_VAULT_URL}/v1/capabilities"

_API_KEY = "creek-vault-test-key"  # pragma: allowlist secret

_SENTINEL_KEY = "SENTINEL_VAULT_KEY_DO_NOT_LEAK"

# A password smuggled into the URL's userinfo component. httpx renders userinfo
# unmasked in ``str(url)`` and in its own INFO request log, and derives Basic
# auth from it that silently replaces our bearer -- so the adapter must refuse
# such a URL, and its refusal message must not repeat this value.
_URL_PASSWORD = "URLPASSWORD_DO_NOT_LEAK"  # pragma: allowlist secret

_USERINFO_VAULT_URL = f"https://opuser:{_URL_PASSWORD}@vault.example.test"

# A configured URL carrying a path prefix: still legal, and the capability path
# must be appended to it rather than replacing it.
_PATH_VAULT_URL = f"{_VAULT_URL}/vault/"

_ENTRY_BODY = "a floor-level journal entry"

_CREATED_AT = datetime(2026, 7, 31, 12, 0, tzinfo=UTC)

_POOL_ATTR = "services.creek_vault_client._VAULT_HTTP_POOL"

_DEADLINE_ATTR = "services.creek_vault_client._VAULT_TOTAL_DEADLINE_SECONDS"

# A whole-request deadline short enough to expire during a test, paired with a
# handler sleep two orders of magnitude longer so the deadline -- never the
# sleep -- is what ends the call. The sleep is cancelled the moment the deadline
# fires, so the test costs milliseconds, not seconds.
_TINY_DEADLINE_SECONDS = 0.02
_SLOW_HANDLER_SLEEP_SECONDS = 5.0

# The redirect status a hijacked or misconfigured vault would answer with; it
# must degrade rather than forward the bearer to the Location host.
_REDIRECT_STATUS_FOUND = 302

_PROTOCOL_MEMBERS = (
    "handshake",
    "is_available",
    "supports",
    "ingest",
    "classify",
    "reflect",
    "wheel",
)

Handler = Callable[[httpx.Request], httpx.Response]
# Narrower than ``Awaitable`` on purpose: ``httpx.MockTransport`` accepts a
# coroutine function specifically, so a wider alias fails to type-check at the
# call site.
AsyncHandler = Callable[[httpx.Request], Coroutine[None, None, httpx.Response]]
ClientFactory = Callable[[Handler | AsyncHandler], httpx.AsyncClient]


def _handshake_payload(
    capabilities: Sequence[str],
    contract_version: str = CONTRACT_VERSION,
    ontology_version: str = "aptitude-wavelength/2026-05-23",
    attestation: Mapping[str, object] | None = None,
    *,
    available: bool = True,
) -> dict[str, object]:
    """Build the only capability response shape adepthood already parses."""
    return {
        "available": available,
        "capabilities": list(capabilities),
        "contract_version": contract_version,
        "ontology_version": ontology_version,
        "attestation": attestation,
    }


def _json_handler(payload: object, status_code: int = 200) -> Handler:
    """Return a handler answering every request with ``payload`` as JSON."""

    def _handle(_request: httpx.Request) -> httpx.Response:
        """Answer with the fixed JSON payload and status."""
        return httpx.Response(status_code, json=payload)

    return _handle


def _text_handler(body: str, status_code: int = 200) -> Handler:
    """Return a handler answering with a non-JSON text body (a proxy error page)."""

    def _handle(_request: httpx.Request) -> httpx.Response:
        """Answer with the fixed text body and status."""
        return httpx.Response(status_code, text=body)

    return _handle


def _raising_handler(exc: Exception) -> Handler:
    """Return a handler that raises ``exc`` instead of answering."""

    def _handle(_request: httpx.Request) -> httpx.Response:
        """Raise the stored transport exception."""
        raise exc

    return _handle


def _redirect_handler(location: str) -> Handler:
    """Return a handler answering with a redirect to ``location`` and no body."""

    def _handle(_request: httpx.Request) -> httpx.Response:
        """Answer with the fixed redirect."""
        return httpx.Response(_REDIRECT_STATUS_FOUND, headers={"Location": location})

    return _handle


async def _slow_handler(_request: httpx.Request) -> httpx.Response:
    """Sleep far past any plausible deadline instead of answering.

    Stands in for a vault that accepts the connection and then trickles: every
    per-phase httpx budget stays unexhausted, so only a whole-request deadline
    can end the call.
    """
    await asyncio.sleep(_SLOW_HANDLER_SLEEP_SECONDS)
    return httpx.Response(200, json={})


def _healthy_handler(capabilities: Sequence[str]) -> Handler:
    """Return a handler answering with a healthy capability payload."""
    return _json_handler(_handshake_payload(capabilities))


def _payload_without_contract_version() -> dict[str, object]:
    """Build a capability payload whose contract_version key is absent."""
    payload = _handshake_payload([CreekCapability.JOURNAL.value])
    del payload["contract_version"]
    return payload


def _ingest_request() -> VaultIngestRequest:
    """Build a minimal ingest request for the refusal paths."""
    return VaultIngestRequest(
        entry_id=7,
        body=_ENTRY_BODY,
        tier=VaultTierCeiling.OPEN,
        tier_ceiling=VaultTierCeiling.OPEN,
        created_at=_CREATED_AT,
    )


class _RecordingHandler:
    """Handler that records every request it serves and answers with a fixed payload."""

    def __init__(self, payload: Mapping[str, object]) -> None:
        """Store the payload to answer with and start an empty request log."""
        self._payload = dict(payload)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record the request and answer 200 with the stored payload."""
        self.requests.append(request)
        return httpx.Response(200, json=self._payload)


class _CountingClientBuild:
    """Client factory that records every httpx client it builds."""

    def __init__(self, handler: Handler) -> None:
        """Store the handler each built client answers from."""
        self._handler = handler
        self.built: list[httpx.AsyncClient] = []

    def __call__(self) -> httpx.AsyncClient:
        """Build one MockTransport-backed client and record it."""
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(self._handler), timeout=_VAULT_HTTP_TIMEOUT
        )
        self.built.append(client)
        return client


@asynccontextmanager
async def _isolated_factory_patch() -> AsyncGenerator[None, None]:
    """Point main's session factory at the conftest SQLite engine for lifespan runs."""
    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    with patch("main.async_session_factory", new=factory):
        yield


@pytest_asyncio.fixture(autouse=True)
async def _closed_vault_pool() -> AsyncGenerator[None, None]:
    """Close the module-level vault HTTP pool after every test so none is GC'd open."""
    yield
    await close_creek_vault_http_pool()


@pytest_asyncio.fixture
async def http_clients() -> AsyncGenerator[ClientFactory, None]:
    """Yield a factory for MockTransport-backed clients, closing each afterwards."""
    created: list[httpx.AsyncClient] = []

    def _build(handler: Handler | AsyncHandler) -> httpx.AsyncClient:
        """Build one in-memory client and register it for teardown."""
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), timeout=_VAULT_HTTP_TIMEOUT
        )
        created.append(client)
        return client

    yield _build
    for client in created:
        await client.aclose()


async def _call_capability(client: HttpCreekVaultClient, capability: CreekCapability) -> object:
    """Invoke the client method that implements ``capability``."""
    if capability is CreekCapability.JOURNAL:
        return await client.ingest(_ingest_request())
    if capability is CreekCapability.CLASSIFY:
        return await client.classify(_ENTRY_BODY, VaultTierCeiling.OPEN)
    if capability is CreekCapability.REFLECT:
        return await client.reflect(_ENTRY_BODY, VaultTierCeiling.OPEN)
    return await client.wheel()


@pytest.mark.asyncio
async def test_http_client_satisfies_the_vault_client_protocol(
    http_clients: ClientFactory,
) -> None:
    """The HTTP adapter is assignable to the domain protocol and exposes every member."""
    client: CreekVaultClient = HttpCreekVaultClient(
        _VAULT_URL,
        _API_KEY,
        http_client=http_clients(_healthy_handler([CreekCapability.JOURNAL.value])),
    )
    for name in _PROTOCOL_MEMBERS:
        assert callable(getattr(client, name)), name


@pytest.mark.asyncio
async def test_fresh_http_client_reports_unavailable_before_any_handshake(
    http_clients: ClientFactory,
) -> None:
    """A client that has not handshaken yet fails safe: unavailable, nothing supported."""
    client = HttpCreekVaultClient(
        _VAULT_URL,
        _API_KEY,
        http_client=http_clients(_healthy_handler([CreekCapability.JOURNAL.value])),
    )
    assert client.is_available() is False
    assert client.supports(CreekCapability.JOURNAL) is False


@pytest.mark.asyncio
async def test_handshake_gets_v1_capabilities_with_bearer_auth(
    http_clients: ClientFactory,
) -> None:
    """The handshake is a single GET of /v1/capabilities carrying the bearer key."""
    handler = _RecordingHandler(_handshake_payload([CreekCapability.JOURNAL.value]))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    await client.handshake()
    assert len(handler.requests) == 1
    request = handler.requests[0]
    assert request.method == "GET"
    assert str(request.url) == _CAPABILITIES_URL
    assert request.headers["Authorization"] == f"Bearer {_API_KEY}"


@pytest.mark.asyncio
async def test_healthy_handshake_narrows_capabilities_and_drops_unknown_ones(
    http_clients: ClientFactory,
) -> None:
    """A healthy payload populates the result and silently drops unknown capability strings."""
    handler = _healthy_handler(
        [CreekCapability.JOURNAL.value, CreekCapability.REFLECT.value, "creek.telepathy"]
    )
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    result = await client.handshake()
    assert result.available is True
    assert result.capabilities == frozenset({CreekCapability.JOURNAL, CreekCapability.REFLECT})
    assert result.contract_version == CONTRACT_VERSION
    assert client.is_available() is True
    assert client.supports(CreekCapability.JOURNAL) is True
    assert client.supports(CreekCapability.REFLECT) is True
    assert client.supports(CreekCapability.CLASSIFY) is False
    assert client.last_degrade_reason is None


@pytest.mark.asyncio
async def test_factory_builds_one_http_client_for_every_vault_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two vault clients share one pooled httpx client across both of their handshakes."""
    monkeypatch.setenv("CREEK_VAULT_URL", _VAULT_URL)
    monkeypatch.setenv("CREEK_VAULT_PROTOCOL", "http")
    monkeypatch.setenv("CREEK_VAULT_API_KEY", _API_KEY)
    handler = _RecordingHandler(_handshake_payload([CreekCapability.JOURNAL.value]))
    build = _CountingClientBuild(handler)
    pool = _VaultHttpPool(build=build)
    monkeypatch.setattr(_POOL_ATTR, pool)

    first = build_creek_vault_client()
    second = build_creek_vault_client()
    assert first is not second
    assert (await first.handshake()).available is True
    assert (await second.handshake()).available is True

    assert len(build.built) == 1
    assert pool.get() is build.built[0]
    assert len(handler.requests) == 2
    await pool.aclose()


@pytest.mark.asyncio
async def test_pool_builds_lazily_exactly_once() -> None:
    """The pool builds on first get and returns that same client on every later get."""
    build = _CountingClientBuild(_healthy_handler([CreekCapability.JOURNAL.value]))
    pool = _VaultHttpPool(build=build)
    assert len(build.built) == 0
    client = pool.get()
    assert pool.get() is client
    assert len(build.built) == 1
    await pool.aclose()


@pytest.mark.asyncio
async def test_close_pool_closes_the_client_and_is_idempotent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Shutdown closes the pooled client, and closing again is a silent no-op."""
    build = _CountingClientBuild(_healthy_handler([CreekCapability.JOURNAL.value]))
    pool = _VaultHttpPool(build=build)
    monkeypatch.setattr(_POOL_ATTR, pool)
    client = pool.get()

    await close_creek_vault_http_pool()
    assert client.is_closed is True

    await close_creek_vault_http_pool()
    assert len(build.built) == 1


@pytest.mark.asyncio
async def test_lifespan_closes_the_vault_http_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    """App shutdown awaits the pool-close hook so no httpx client outlives the process."""
    monkeypatch.setenv("SKIP_STARTUP_SEED", "1")
    spy = AsyncMock()
    with patch("main.close_creek_vault_http_pool", new=spy):
        async with _isolated_factory_patch(), lifespan(app):
            pass
    spy.assert_awaited_once()


def test_vault_http_timeout_pins_every_phase_to_the_budget() -> None:
    """Connect, read, write, and pool timeouts are each set to the vault budget."""
    phases = (
        _VAULT_HTTP_TIMEOUT.connect,
        _VAULT_HTTP_TIMEOUT.read,
        _VAULT_HTTP_TIMEOUT.write,
        _VAULT_HTTP_TIMEOUT.pool,
    )
    for phase in phases:
        assert phase is not None
        assert phase == _VAULT_TIMEOUT_SECONDS


@pytest.mark.asyncio
async def test_pooled_client_carries_the_explicit_timeout() -> None:
    """The pool's own client is built with the module's fully specified timeout."""
    pool = _VaultHttpPool()
    client = pool.get()
    assert client.timeout == _VAULT_HTTP_TIMEOUT
    await pool.aclose()


@pytest.mark.asyncio
async def test_pooled_client_refuses_to_follow_redirects() -> None:
    """The pooled client pins redirect-following off rather than inheriting the default."""
    client = _build_pooled_vault_client()
    try:
        assert client.follow_redirects is False
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_a_redirecting_vault_degrades_instead_of_forwarding_the_bearer(
    http_clients: ClientFactory,
) -> None:
    """A 302 degrades to unreachable: the bearer is never re-sent to the Location host."""
    handler = _redirect_handler("https://attacker.example.test/v1/capabilities")
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    result = await client.handshake()
    assert result == HandshakeResult.unavailable()
    assert client.last_degrade_reason is HandshakeDegradeReason.UNREACHABLE


def test_the_total_deadline_exceeds_a_single_phase_budget() -> None:
    """The whole-request deadline leaves room for a slow connect *and* a slow read."""
    assert _VAULT_TOTAL_DEADLINE_SECONDS > _VAULT_TIMEOUT_SECONDS


@pytest.mark.asyncio
async def test_a_trickling_vault_is_bounded_by_the_whole_request_deadline(
    monkeypatch: pytest.MonkeyPatch,
    http_clients: ClientFactory,
) -> None:
    """A call that outlives the deadline degrades to unreachable rather than hanging."""
    monkeypatch.setattr(_DEADLINE_ATTR, _TINY_DEADLINE_SECONDS)
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(_slow_handler))
    result = await client.handshake()
    assert result == HandshakeResult.unavailable()
    assert client.last_degrade_reason is HandshakeDegradeReason.UNREACHABLE


@pytest.mark.asyncio
async def test_hung_vault_degrades_within_the_timeout_budget(
    http_clients: ClientFactory,
) -> None:
    """A read timeout degrades to unavailable and is reported as unreachable, never raised."""
    handler = _raising_handler(httpx.ReadTimeout("vault never answered"))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    result = await client.handshake()
    assert result == HandshakeResult.unavailable()
    assert client.last_degrade_reason is HandshakeDegradeReason.UNREACHABLE


@pytest.mark.parametrize(
    "handler",
    [
        pytest.param(_raising_handler(httpx.ConnectError("refused")), id="connection_refused"),
        pytest.param(_json_handler({"detail": "boom"}, 500), id="server_error"),
        pytest.param(_json_handler({"detail": "unauthorized"}, 401), id="unauthorized"),
        pytest.param(_text_handler("<html><body>Bad Gateway</body></html>"), id="non_json_body"),
        pytest.param(_json_handler([1, 2, 3]), id="json_is_not_an_object"),
        pytest.param(_json_handler(_payload_without_contract_version()), id="missing_version"),
        pytest.param(
            _json_handler(_handshake_payload([CreekCapability.JOURNAL.value], "0.3.0")),
            id="incompatible_version",
        ),
    ],
)
@pytest.mark.asyncio
async def test_handshake_degrades_to_unavailable_without_raising(
    handler: Handler,
    http_clients: ClientFactory,
) -> None:
    """Every unhealthy vault response collapses to the one canonical unavailable result."""
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    result = await client.handshake()
    assert result == HandshakeResult.unavailable()
    assert client.is_available() is False
    assert client.supports(CreekCapability.JOURNAL) is False


@pytest.mark.parametrize(
    ("handler", "expected"),
    [
        pytest.param(
            _json_handler(_handshake_payload([CreekCapability.JOURNAL.value], "0.3.0")),
            HandshakeDegradeReason.INCOMPATIBLE_VERSION,
            id="incompatible_version",
        ),
        pytest.param(
            _raising_handler(httpx.ConnectError("refused")),
            HandshakeDegradeReason.UNREACHABLE,
            id="unreachable",
        ),
        pytest.param(
            _text_handler("<html><body>Bad Gateway</body></html>"),
            HandshakeDegradeReason.MALFORMED_PAYLOAD,
            id="malformed_payload",
        ),
        pytest.param(
            _json_handler(_handshake_payload([CreekCapability.JOURNAL.value], available=False)),
            HandshakeDegradeReason.VAULT_REPORTED_UNAVAILABLE,
            id="vault_reported_unavailable",
        ),
    ],
)
@pytest.mark.asyncio
async def test_degrade_reason_distinguishes_the_failure_modes(
    handler: Handler,
    expected: HandshakeDegradeReason,
    http_clients: ClientFactory,
) -> None:
    """Each degrade path records its own reason so version skew is visible separately."""
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    await client.handshake()
    assert client.last_degrade_reason is expected


@pytest.mark.asyncio
async def test_incompatible_and_unreachable_return_the_same_degraded_result(
    http_clients: ClientFactory,
) -> None:
    """Callers see one degraded state; only the internal degrade reason differs."""
    skewed = HttpCreekVaultClient(
        _VAULT_URL,
        _API_KEY,
        http_client=http_clients(
            _json_handler(_handshake_payload([CreekCapability.JOURNAL.value], "0.3.0"))
        ),
    )
    offline = HttpCreekVaultClient(
        _VAULT_URL,
        _API_KEY,
        http_client=http_clients(_raising_handler(httpx.ConnectError("refused"))),
    )
    skewed_result = await skewed.handshake()
    offline_result = await offline.handshake()
    assert skewed_result == offline_result == HandshakeResult.unavailable()
    assert skewed.last_degrade_reason is HandshakeDegradeReason.INCOMPATIBLE_VERSION
    assert offline.last_degrade_reason is HandshakeDegradeReason.UNREACHABLE


def test_degrade_reason_wire_values_are_stable() -> None:
    """The degrade reasons carry the exact strings telemetry will count."""
    assert [reason.value for reason in HandshakeDegradeReason] == [
        "unreachable",
        "malformed_payload",
        "incompatible_version",
        "vault_reported_unavailable",
    ]


@pytest.mark.parametrize(
    ("advertised", "pinned", "compatible"),
    [
        pytest.param("0.3.0", "0.2.0", False, id="pre_1_0_minor_bump_rejected"),
        pytest.param("0.2.7", "0.2.1", True, id="pre_1_0_patch_bump_accepted"),
        pytest.param("1.5.0", "1.2.0", True, id="post_1_0_forward_minor_accepted"),
        pytest.param("2.0.0", "1.2.0", False, id="post_1_0_major_bump_rejected"),
    ],
)
def test_contract_version_compatibility_rule(
    advertised: str, pinned: str, compatible: bool
) -> None:
    """Pre-1.0 requires an exact major.minor match; 1.0 and later relaxes to major-match."""
    assert _contract_version_compatible(advertised, pinned) is compatible


def test_contract_version_compatible_defaults_to_the_pinned_constant() -> None:
    """The pinned contract version is, trivially, compatible with itself."""
    assert _contract_version_compatible(CONTRACT_VERSION) is True


@pytest.mark.parametrize("url", ["", None], ids=["empty", "unset"])
@pytest.mark.parametrize("protocol", [None, "mcp", "http"], ids=["unset", "mcp", "http"])
def test_factory_returns_local_fallback_when_no_url_under_every_protocol(
    url: str | None, protocol: str | None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No configured vault URL means the local fallback, whatever the protocol says."""
    if url is None:
        monkeypatch.delenv("CREEK_VAULT_URL", raising=False)
    else:
        monkeypatch.setenv("CREEK_VAULT_URL", url)
    if protocol is None:
        monkeypatch.delenv("CREEK_VAULT_PROTOCOL", raising=False)
    else:
        monkeypatch.setenv("CREEK_VAULT_PROTOCOL", protocol)
    assert isinstance(build_creek_vault_client(), LocalFallbackCreekVaultClient)


@pytest.mark.parametrize("protocol", [None, "mcp", "MCP "], ids=["unset", "mcp", "padded_upper"])
def test_factory_keeps_mcp_as_the_default_protocol(
    protocol: str | None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unset, lowercase, or whitespace-padded mcp selector still yields the MCP adapter."""
    monkeypatch.setenv("CREEK_VAULT_URL", _VAULT_URL)
    monkeypatch.setenv("CREEK_VAULT_API_KEY", _API_KEY)
    if protocol is None:
        monkeypatch.delenv("CREEK_VAULT_PROTOCOL", raising=False)
    else:
        monkeypatch.setenv("CREEK_VAULT_PROTOCOL", protocol)
    assert isinstance(build_creek_vault_client(), McpCreekVaultClient)


def test_factory_returns_http_client_when_protocol_is_http(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The http selector swaps in the HTTP/JSON adapter."""
    monkeypatch.setenv("CREEK_VAULT_URL", _VAULT_URL)
    monkeypatch.setenv("CREEK_VAULT_API_KEY", _API_KEY)
    monkeypatch.setenv("CREEK_VAULT_PROTOCOL", "http")
    assert isinstance(build_creek_vault_client(), HttpCreekVaultClient)


def test_factory_rejects_an_unknown_protocol_naming_only_the_bad_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unrecognized protocol fails loudly and names the offending value, not the key."""
    monkeypatch.setenv("CREEK_VAULT_URL", _VAULT_URL)
    monkeypatch.setenv("CREEK_VAULT_API_KEY", _SENTINEL_KEY)
    monkeypatch.setenv("CREEK_VAULT_PROTOCOL", "grpc")
    with pytest.raises(ValueError, match="grpc") as exc_info:
        build_creek_vault_client()
    assert _SENTINEL_KEY not in str(exc_info.value)


def test_http_factory_rejects_a_plaintext_remote_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """Plaintext to a remote host fails closed at construction, before the key is bound."""
    monkeypatch.setenv("CREEK_VAULT_URL", "http://vault.example.test")
    monkeypatch.setenv("CREEK_VAULT_API_KEY", _SENTINEL_KEY)
    monkeypatch.setenv("CREEK_VAULT_PROTOCOL", "http")
    with pytest.raises(ValueError, match="https") as exc_info:
        build_creek_vault_client()
    message = str(exc_info.value)
    assert "http" in message
    assert "vault.example.test" in message
    assert _SENTINEL_KEY not in message


def test_http_factory_accepts_a_plaintext_loopback_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """Plaintext to loopback stays allowed so a developer can run a vault locally."""
    monkeypatch.setenv("CREEK_VAULT_URL", "http://localhost:8000")
    monkeypatch.setenv("CREEK_VAULT_API_KEY", _API_KEY)
    monkeypatch.setenv("CREEK_VAULT_PROTOCOL", "http")
    assert isinstance(build_creek_vault_client(), HttpCreekVaultClient)


@pytest.mark.parametrize(
    ("url", "part"),
    [
        pytest.param(_USERINFO_VAULT_URL, "userinfo", id="userinfo"),
        pytest.param(f"{_VAULT_URL}/api?tenant=1", "query", id="query"),
        pytest.param(f"{_VAULT_URL}#frag", "fragment", id="fragment"),
    ],
)
def test_http_client_rejects_a_url_carrying_userinfo_query_or_fragment(url: str, part: str) -> None:
    """Userinfo (a credential, and a silent Basic-auth downgrade), query, and fragment refuse."""
    with pytest.raises(ValueError, match=part) as exc_info:
        HttpCreekVaultClient(url, _SENTINEL_KEY)
    message = str(exc_info.value)
    assert _URL_PASSWORD not in message
    assert _SENTINEL_KEY not in message


def test_mcp_transport_rejects_a_url_carrying_userinfo(monkeypatch: pytest.MonkeyPatch) -> None:
    """The MCP transport shares the validator, so it refuses the same URL shapes."""
    monkeypatch.setenv("CREEK_VAULT_URL", _USERINFO_VAULT_URL)
    monkeypatch.setenv("CREEK_VAULT_API_KEY", _SENTINEL_KEY)
    monkeypatch.setenv("CREEK_VAULT_PROTOCOL", "mcp")
    with pytest.raises(ValueError, match="userinfo") as exc_info:
        build_creek_vault_client()
    message = str(exc_info.value)
    assert _URL_PASSWORD not in message
    assert _SENTINEL_KEY not in message


@pytest.mark.asyncio
async def test_a_url_with_a_path_prefix_keeps_it_in_the_capability_url(
    http_clients: ClientFactory,
) -> None:
    """A path prefix stays legal and the capability path is appended to it."""
    handler = _RecordingHandler(_handshake_payload([CreekCapability.JOURNAL.value]))
    client = HttpCreekVaultClient(_PATH_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    assert (await client.handshake()).available is True
    assert str(handler.requests[0].url) == f"{_VAULT_URL}/vault/v1/capabilities"


@pytest.mark.parametrize(
    "capability",
    [
        CreekCapability.JOURNAL,
        CreekCapability.CLASSIFY,
        CreekCapability.REFLECT,
        CreekCapability.WHEEL,
    ],
)
@pytest.mark.asyncio
async def test_advertised_capabilities_are_still_refused(
    capability: CreekCapability,
    http_clients: ClientFactory,
) -> None:
    """Even an advertised capability is refused, since its payload shape is unratified."""
    advertised = [
        CreekCapability.JOURNAL.value,
        CreekCapability.CLASSIFY.value,
        CreekCapability.REFLECT.value,
        CreekCapability.WHEEL.value,
    ]
    client = HttpCreekVaultClient(
        _VAULT_URL, _API_KEY, http_client=http_clients(_healthy_handler(advertised))
    )
    await client.handshake()
    assert client.supports(capability) is True
    with pytest.raises(CreekCapabilityUnsupportedError) as exc_info:
        await _call_capability(client, capability)
    assert capability.value in str(exc_info.value)


@pytest.mark.asyncio
async def test_write_path_degrades_instead_of_losing_an_entry(
    http_clients: ClientFactory,
) -> None:
    """A refused ingest degrades the write path rather than raising or dropping the entry."""
    client = HttpCreekVaultClient(
        _VAULT_URL,
        _API_KEY,
        http_client=http_clients(_healthy_handler([CreekCapability.JOURNAL.value])),
    )
    outcome = await store_and_classify(
        client,
        entry_id=7,
        body=_ENTRY_BODY,
        classification="public",
        created_at=_CREATED_AT,
    )
    assert outcome.status is VaultWriteStatus.DEGRADED
    assert outcome.vault_ref is None
    assert outcome.tags == ()


@pytest.mark.asyncio
async def test_api_key_never_leaks_into_logs_repr_or_errors(
    caplog: pytest.LogCaptureFixture,
    http_clients: ClientFactory,
) -> None:
    """No log record, repr, or exception text ever carries the bearer credential."""
    caplog.set_level(logging.DEBUG)
    healthy = HttpCreekVaultClient(
        _VAULT_URL,
        _SENTINEL_KEY,
        http_client=http_clients(_healthy_handler([CreekCapability.JOURNAL.value])),
    )
    hung = HttpCreekVaultClient(
        _VAULT_URL,
        _SENTINEL_KEY,
        http_client=http_clients(_raising_handler(httpx.ReadTimeout("vault never answered"))),
    )
    failing = HttpCreekVaultClient(
        _VAULT_URL,
        _SENTINEL_KEY,
        http_client=http_clients(_json_handler({"detail": "boom"}, 500)),
    )
    for client in (healthy, hung, failing):
        await client.handshake()
    with pytest.raises(CreekCapabilityUnsupportedError) as exc_info:
        await healthy.ingest(_ingest_request())

    assert _SENTINEL_KEY not in caplog.text
    for record in caplog.records:
        assert _SENTINEL_KEY not in record.getMessage()
    for client in (healthy, hung, failing):
        assert _SENTINEL_KEY not in repr(client)
        assert _SENTINEL_KEY not in str(client)
        assert repr(client) == object.__repr__(client)
    assert _SENTINEL_KEY not in str(exc_info.value)
    assert exc_info.value.__cause__ is None
    assert exc_info.value.__suppress_context__ is True
