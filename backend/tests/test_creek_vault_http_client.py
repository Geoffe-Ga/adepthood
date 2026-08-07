"""Tests for the HTTP/JSON Creek Vault adapter in services.creek_vault_client.

Every case drives the adapter through an ``httpx.MockTransport`` handler, so no
test touches a network or waits on real time. Three response shapes are asserted
here: the capability document the handshake already parses, the journal ingest
exchange, and the wheel read -- the capabilities whose ``/v1`` shapes Creek has
ratified. Nothing beyond those is invented, and every wheel body is read from the
vendored contract bundle rather than written out here.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncGenerator, Callable, Coroutine, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from http import HTTPStatus
from typing import cast
from unittest.mock import AsyncMock, patch

import httpx
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from conftest import test_engine
from domain.constants import TOTAL_STAGES
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultAuthError,
    CreekVaultClient,
    CreekVaultContractError,
    CreekVaultError,
    CreekVaultPayloadError,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultErrorCode,
    VaultIngestAction,
    VaultIngestRequest,
    VaultTierCeiling,
)
from main import app, lifespan
from scripts.creek_contract_drift import BUNDLE_ROOT
from services.creek_vault_client import (
    _MAX_FRAGMENT_ID_LENGTH,
    _VAULT_HTTP_TIMEOUT,
    _VAULT_TIMEOUT_SECONDS,
    _VAULT_TOTAL_DEADLINE_SECONDS,
    HandshakeDegradeReason,
    HttpCreekVaultClient,
    LocalFallbackCreekVaultClient,
    McpCreekVaultClient,
    _build_pooled_vault_client,
    _contract_version_compatible,
    _entry_path_segment,
    _VaultHttpPool,
    build_creek_vault_client,
    close_creek_vault_http_pool,
)
from services.creek_vault_write import VaultWriteStatus, store_and_classify

_VAULT_URL = "https://vault.example.test"

_CAPABILITIES_PATH = "/v1/capabilities"

_CAPABILITIES_URL = f"{_VAULT_URL}{_CAPABILITIES_PATH}"

# The wheel is a whole-corpus aggregate rather than a resource, so it is read
# from one collection-level URL carrying no parameters at all.
_WHEEL_PATH = "/v1/wheel"

_WHEEL_URL = f"{_VAULT_URL}{_WHEEL_PATH}"

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

# A body distinct enough to spot anywhere it must never appear: an exception
# message, a repr, or a log record.
_SENTINEL_BODY = "SENTINEL_ENTRY_BODY_DO_NOT_LEAK"

_CREATED_AT = datetime(2026, 7, 31, 12, 0, tzinfo=UTC)

# The stable external id the vault keys the stored fragment off, and the URL a
# PUT for it must land on.
_ENTRY_ID = 7

_JOURNAL_ENTRY_URL = f"{_VAULT_URL}/v1/journal-entries/{_ENTRY_ID}"

_FRAGMENT_ID = "frag-7"

# A hostile ``code`` a compromised or buggy vault could answer with: an
# unrecognized value carrying CRLF (log-injection) plus a token that must never
# be echoed. The adapter may parse only its own enum values, so this whole
# string has to be dropped rather than stored, formatted, or logged.
_HOSTILE_CODE_SENTINEL = "HOSTILE_VAULT_CODE_SENTINEL"
_HOSTILE_VAULT_CODE = f"not_a_real_code\r\n{_HOSTILE_CODE_SENTINEL}"

# Two fragment ids a compromised vault could answer a healthy 2xx with. The
# oversized one is storage amplification -- ``vault_ref`` is an unbounded text
# column written on every journal save -- and the hostile one carries the bytes
# (NUL, CRLF) that a text column rejects outright and a log line must never
# receive. Neither may become an entry's durable vault reference.
_OVERSIZED_FRAGMENT_ID = "f" * (_MAX_FRAGMENT_ID_LENGTH + 1)
_HOSTILE_FRAGMENT_ID = "frag\r\n\x00-7"

# The longest fragment id that is still storable, so the bound is asserted at
# its edge rather than merely somewhere beyond it.
_LONGEST_USABLE_FRAGMENT_ID = "f" * _MAX_FRAGMENT_ID_LENGTH

# A vault URL whose port is not a number. ``urlsplit`` accepts it -- so the
# construction-time security validator does too, since it never reads the port
# -- while httpx refuses to build a request for it, raising ``InvalidURL`` from
# outside its own ``HTTPError`` hierarchy. It stands in for an operator typo (a
# shell-interpolated port that came out non-numeric), which must degrade like
# any other unreachable vault rather than raise into the caller's request path.
_UNPARSEABLE_VAULT_URL = "https://vault.example.test:not-a-port"

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


def _ingest_request(
    tier: VaultTierCeiling = VaultTierCeiling.OPEN, body: str = _ENTRY_BODY
) -> VaultIngestRequest:
    """Build an ingest request at ``tier`` carrying ``body``.

    An entry's own tier and its write ceiling are always the same value on the
    journal path, so one argument sets both.
    """
    return VaultIngestRequest(
        entry_id=_ENTRY_ID,
        body=body,
        tier=tier,
        tier_ceiling=tier,
        created_at=_CREATED_AT,
    )


def _ingest_payload(
    fragment_id: object = _FRAGMENT_ID,
    action: str = VaultIngestAction.CREATED.value,
) -> dict[str, object]:
    """Build a vault ingest response body carrying ``action`` and ``fragment_id``."""
    return {"action": action, "fragment_id": fragment_id}


def _error_payload(code: str) -> dict[str, object]:
    """Build a vault error body carrying a machine-readable ``code``."""
    return {"code": code, "detail": "the vault refused this request"}


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


@dataclass(frozen=True)
class _IngestReply:
    """One scripted answer to a journal-entry PUT: a status plus a JSON or text body."""

    status: int = HTTPStatus.OK
    payload: object = None
    text: str | None = None

    def to_response(self) -> httpx.Response:
        """Build the httpx response this reply describes."""
        if self.text is not None:
            return httpx.Response(self.status, text=self.text)
        return httpx.Response(self.status, json=self.payload)


_CREATED_REPLY = _IngestReply(payload=_ingest_payload())


class _VaultRouteHandler:
    """Route-aware handler: a healthy capability GET plus scripted journal PUTs.

    The handshake and the ingest have different shapes and different failure
    modes, so a test needs to script them independently while still seeing every
    request that crossed the transport. Replies are consumed in order and the
    last one repeats, so a two-call test scripts exactly two.
    """

    def __init__(
        self,
        replies: Sequence[_IngestReply] = (),
        *,
        capabilities: Sequence[str] = (CreekCapability.JOURNAL.value,),
        ingest_error: Exception | None = None,
    ) -> None:
        """Store the advertised capabilities, the PUT script, and any PUT failure."""
        self._capabilities = list(capabilities)
        self._replies = list(replies) or [_CREATED_REPLY]
        self._ingest_error = ingest_error
        self.requests: list[httpx.Request] = []

    @property
    def ingest_requests(self) -> list[httpx.Request]:
        """Return only the journal-entry PUTs this handler has served."""
        return [request for request in self.requests if request.method == "PUT"]

    def _next_reply(self) -> _IngestReply:
        """Return this PUT's scripted reply, repeating the last once the script runs out."""
        return self._replies[min(len(self.ingest_requests) - 1, len(self._replies) - 1)]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record the request, then answer the capability GET or the scripted PUT."""
        self.requests.append(request)
        if request.method == "GET":
            return httpx.Response(HTTPStatus.OK, json=_handshake_payload(self._capabilities))
        if self._ingest_error is not None:
            raise self._ingest_error
        return self._next_reply().to_response()


class _SlowIngestHandler:
    """Handler that handshakes healthily and then trickles forever on the journal PUT."""

    def __init__(self) -> None:
        """Start an empty request log."""
        self.requests: list[httpx.Request] = []

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        """Answer the capability GET at once; never finish the PUT within any deadline."""
        self.requests.append(request)
        if request.method == "GET":
            return httpx.Response(
                HTTPStatus.OK, json=_handshake_payload([CreekCapability.JOURNAL.value])
            )
        await asyncio.sleep(_SLOW_HANDLER_SLEEP_SECONDS)
        return httpx.Response(HTTPStatus.OK, json=_ingest_payload())


def _wheel_example(state: str) -> dict[str, object]:
    """Return one vendored wheel example body, decoded fresh on every call.

    Fresh because the callers below build malformed variants by editing what
    they get back: the vendored file is read-only ground truth, and a shared
    decoded object would let one test's mutation reach another's.
    """
    decoded = json.loads((BUNDLE_ROOT / f"examples/wheel/{state}.json").read_bytes())
    assert isinstance(decoded, dict), state
    return decoded


def _wheel_frequencies(payload: Mapping[str, object]) -> dict[str, Mapping[str, object]]:
    """Return the ten published Frequency entries of a wheel body."""
    frequencies = payload["wheel"]
    assert isinstance(frequencies, dict)
    return {code: entry for code, entry in frequencies.items() if isinstance(entry, Mapping)}


def _wheel_required_keys() -> tuple[str, ...]:
    """Return the top-level fields Creek's wheel schema declares required."""
    schema = json.loads((BUNDLE_ROOT / "schemas/WheelResponse.schema.json").read_bytes())
    assert isinstance(schema, dict)
    required = schema["required"]
    assert isinstance(required, list)
    return tuple(str(key) for key in required)


def _wheel_with_ceiling(ceiling: str) -> dict[str, object]:
    """Return the success example with only its echoed tier ceiling replaced."""
    body = _wheel_example("success")
    body["tier_ceiling"] = ceiling
    return body


def _wheel_without_key(key: str) -> dict[str, object]:
    """Return the success example with one published required field removed."""
    body = _wheel_example("success")
    del body[key]
    return body


def _wheel_without_frequency(code: str) -> dict[str, object]:
    """Return the success example with one Frequency deleted from a copy of its wheel."""
    body = _wheel_example("success")
    frequencies = _wheel_frequencies(body)
    del frequencies[code]
    body["wheel"] = frequencies
    return body


def _wheel_with_share(code: str, share: object) -> dict[str, object]:
    """Return the success example with one Frequency's share replaced."""
    body = _wheel_example("success")
    frequencies = {name: dict(entry) for name, entry in _wheel_frequencies(body).items()}
    frequencies[code]["share"] = share
    body["wheel"] = frequencies
    return body


class _WheelRouteHandler:
    """Route-aware handler: a healthy capability GET plus one scripted wheel GET.

    Kept apart from :class:`_VaultRouteHandler` because the wheel is a different
    route with a different failure vocabulary; sharing one handler would have
    meant a method-and-path branch tree neither exchange needs.
    """

    def __init__(
        self,
        payload: object = None,
        status: int = HTTPStatus.OK,
        *,
        text: str | None = None,
        capabilities: Sequence[str] = (CreekCapability.WHEEL.value,),
        wheel_error: Exception | None = None,
    ) -> None:
        """Store the advertised capabilities and the one scripted wheel answer."""
        self._payload = payload
        self._status = status
        self._text = text
        self._capabilities = list(capabilities)
        self._wheel_error = wheel_error
        self.requests: list[httpx.Request] = []

    @property
    def wheel_requests(self) -> list[httpx.Request]:
        """Return only the wheel reads this handler has served."""
        return [request for request in self.requests if request.url.path == _WHEEL_PATH]

    def _wheel_response(self) -> httpx.Response:
        """Answer the scripted wheel body, raising the scripted transport failure instead."""
        if self._wheel_error is not None:
            raise self._wheel_error
        if self._text is not None:
            return httpx.Response(self._status, text=self._text)
        return httpx.Response(self._status, json=self._payload)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record the request, then answer the capability GET or the scripted wheel GET."""
        self.requests.append(request)
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(HTTPStatus.OK, json=_handshake_payload(self._capabilities))
        return self._wheel_response()


async def _handshaken_client(
    handler: Handler | AsyncHandler,
    http_clients: ClientFactory,
    api_key: str = _API_KEY,
) -> HttpCreekVaultClient:
    """Build a client over ``handler`` and complete its handshake before returning it."""
    client = HttpCreekVaultClient(_VAULT_URL, api_key, http_client=http_clients(handler))
    await client.handshake()
    return client


def _sent_ingest_body(handler: _VaultRouteHandler) -> dict[str, object]:
    """Return the decoded JSON body of the single journal PUT the handler served."""
    assert len(handler.ingest_requests) == 1
    decoded = json.loads(handler.ingest_requests[0].content)
    assert isinstance(decoded, dict)
    return decoded


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
    """Invoke the client method that implements one of the still-unratified capabilities."""
    if capability is CreekCapability.CLASSIFY:
        return await client.classify(_ENTRY_BODY, VaultTierCeiling.OPEN)
    return await client.reflect(_ENTRY_BODY, VaultTierCeiling.OPEN)


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
    # The shared request helper passes ``json=None`` here so one code path can
    # serve both the GET and the journal PUT; httpx encodes that as no body at
    # all, and this pins it -- a GET carrying a body is ambiguous to every proxy
    # between here and the vault.
    assert request.content == b""
    assert "content-type" not in request.headers


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
        CreekCapability.CLASSIFY,
        CreekCapability.REFLECT,
    ],
)
@pytest.mark.asyncio
async def test_advertised_capabilities_are_still_refused(
    capability: CreekCapability,
    http_clients: ClientFactory,
) -> None:
    """Journal and wheel are the ratified capabilities; the other two refuse when advertised.

    Their ``/v1`` payload shapes have not shipped, so an advertised
    classify/reflect still degrades the caller onto its local pipeline rather
    than guessing a wire format.
    """
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
    """A vault that answers the PUT with a fault degrades the write instead of dropping it.

    The vault handshakes healthily and then rejects the ingest itself, so the
    degrade comes from a real failed write rather than from an unwired
    capability.
    """
    handler = _VaultRouteHandler(
        [_IngestReply(status=HTTPStatus.INTERNAL_SERVER_ERROR, payload={"detail": "boom"})]
    )
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    outcome = await store_and_classify(
        client,
        entry_id=_ENTRY_ID,
        body=_ENTRY_BODY,
        classification="public",
        created_at=_CREATED_AT,
    )
    assert outcome.status is VaultWriteStatus.DEGRADED
    assert outcome.vault_ref is None
    assert outcome.tags == ()
    assert len(handler.ingest_requests) == 1


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
        http_client=http_clients(
            _VaultRouteHandler(
                [
                    _IngestReply(
                        status=HTTPStatus.BAD_REQUEST,
                        payload=_error_payload(VaultErrorCode.INVALID_REQUEST.value),
                    )
                ]
            )
        ),
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
    with pytest.raises(CreekVaultContractError) as exc_info:
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


@pytest.mark.asyncio
async def test_ingest_puts_v1_journal_entries_with_bearer_and_exact_body(
    http_clients: ClientFactory,
) -> None:
    """One ingest is one PUT of the entry's own URL, carrying exactly three body fields."""
    handler = _VaultRouteHandler()
    client = await _handshaken_client(handler, http_clients)
    await client.ingest(_ingest_request())

    put = handler.ingest_requests[0]
    assert put.method == "PUT"
    assert str(put.url) == _JOURNAL_ENTRY_URL
    assert put.headers["Authorization"] == f"Bearer {_API_KEY}"
    body = _sent_ingest_body(handler)
    assert set(body) == {"content", "timestamp", "tier"}
    assert body["content"] == _ENTRY_BODY
    assert body["timestamp"] == _CREATED_AT.isoformat()
    assert body["tier"] == VaultTierCeiling.OPEN.value


@pytest.mark.parametrize(
    "entry_id",
    [
        pytest.param("..", id="parent_directory"),
        pytest.param("../../v1", id="two_levels_up"),
        pytest.param(".", id="current_directory"),
        pytest.param("7/../../admin", id="embedded_traversal"),
    ],
)
def test_entry_path_segment_cannot_climb_out_of_the_journal_collection(entry_id: str) -> None:
    """A dot-segment id stays inside the collection instead of redirecting the body.

    ``entry_id`` is typed ``int``, so this is a guard on the *shape* of the URL
    builder rather than a reachable input today -- but the entry body rides on
    this request, so the segment must be inert whatever the identifier type
    becomes. The cast is the point of the test: it is the future change,
    written down.
    """
    segment = _entry_path_segment(cast("int", entry_id))
    url = httpx.URL(f"{_VAULT_URL}/v1/journal-entries/{segment}")
    assert str(url).startswith(f"{_VAULT_URL}/v1/journal-entries/")


@pytest.mark.parametrize(
    "tier",
    [VaultTierCeiling.OPEN, VaultTierCeiling.PERSONAL],
    ids=["open", "personal"],
)
@pytest.mark.asyncio
async def test_ingest_sends_the_entrys_own_tier_never_a_lower_ceiling(
    tier: VaultTierCeiling,
    http_clients: ClientFactory,
) -> None:
    """The stored tier is the writer's own, so the vault never files an entry too widely."""
    handler = _VaultRouteHandler()
    client = await _handshaken_client(handler, http_clients)
    await client.ingest(_ingest_request(tier))
    assert _sent_ingest_body(handler)["tier"] == tier.value


@pytest.mark.parametrize(
    "action",
    list(VaultIngestAction),
    ids=[action.value for action in VaultIngestAction],
)
@pytest.mark.asyncio
async def test_ingest_success_projects_action_and_fragment_id(
    action: VaultIngestAction,
    http_clients: ClientFactory,
) -> None:
    """Every known action is a durable write whose ref is the vault's own fragment id."""
    handler = _VaultRouteHandler([_IngestReply(payload=_ingest_payload(action=action.value))])
    client = await _handshaken_client(handler, http_clients)
    result = await client.ingest(_ingest_request())
    assert result.stored is True
    assert result.vault_ref == _FRAGMENT_ID
    assert result.action is action


@pytest.mark.parametrize(
    "reply",
    [
        pytest.param(_IngestReply(payload=_ingest_payload("")), id="blank_fragment_id"),
        pytest.param(
            _IngestReply(payload={"action": VaultIngestAction.CREATED.value}),
            id="missing_fragment_id",
        ),
        pytest.param(_IngestReply(payload=_ingest_payload(_ENTRY_ID)), id="non_string_fragment_id"),
        pytest.param(
            _IngestReply(payload=_ingest_payload(action="teleported")), id="unknown_action"
        ),
        pytest.param(_IngestReply(payload=[_FRAGMENT_ID]), id="json_is_not_an_object"),
        pytest.param(
            _IngestReply(payload=_ingest_payload(_OVERSIZED_FRAGMENT_ID)),
            id="oversized_fragment_id",
        ),
        pytest.param(
            _IngestReply(payload=_ingest_payload(_HOSTILE_FRAGMENT_ID)),
            id="unprintable_fragment_id",
        ),
    ],
)
@pytest.mark.asyncio
async def test_ingest_without_a_usable_fragment_id_parses_to_not_stored(
    reply: _IngestReply,
    http_clients: ClientFactory,
) -> None:
    """A 2xx adepthood cannot read is not-stored: a ref is never fabricated."""
    client = await _handshaken_client(_VaultRouteHandler([reply]), http_clients)
    result = await client.ingest(_ingest_request())
    assert result.stored is False
    assert result.vault_ref is None
    assert result.action is None


@pytest.mark.asyncio
async def test_ingest_accepts_a_fragment_id_at_the_length_bound(
    http_clients: ClientFactory,
) -> None:
    """The bound refuses only what exceeds it, so a legitimate long handle still stores."""
    handler = _VaultRouteHandler(
        [_IngestReply(payload=_ingest_payload(_LONGEST_USABLE_FRAGMENT_ID))]
    )
    client = await _handshaken_client(handler, http_clients)
    result = await client.ingest(_ingest_request())
    assert result.stored is True
    assert result.vault_ref == _LONGEST_USABLE_FRAGMENT_ID


@pytest.mark.asyncio
async def test_write_path_degrades_on_an_unstorable_fragment_id(
    http_clients: ClientFactory,
) -> None:
    """A hostile ref never becomes an entry's vault_ref -- the write degrades instead."""
    handler = _VaultRouteHandler([_IngestReply(payload=_ingest_payload(_HOSTILE_FRAGMENT_ID))])
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    outcome = await store_and_classify(
        client,
        entry_id=_ENTRY_ID,
        body=_ENTRY_BODY,
        classification="public",
        created_at=_CREATED_AT,
    )
    assert outcome.status is VaultWriteStatus.DEGRADED
    assert outcome.vault_ref is None


@pytest.mark.asyncio
async def test_resending_the_same_entry_id_reports_unchanged_with_the_same_fragment(
    http_clients: ClientFactory,
) -> None:
    """Re-sending an entry edits its one fragment in place rather than creating a second."""
    handler = _VaultRouteHandler(
        [
            _CREATED_REPLY,
            _IngestReply(payload=_ingest_payload(action=VaultIngestAction.UNCHANGED.value)),
        ]
    )
    client = await _handshaken_client(handler, http_clients)
    first = await client.ingest(_ingest_request())
    second = await client.ingest(_ingest_request())

    assert [str(request.url) for request in handler.ingest_requests] == [
        _JOURNAL_ENTRY_URL,
        _JOURNAL_ENTRY_URL,
    ]
    assert first.action is VaultIngestAction.CREATED
    assert second.action is VaultIngestAction.UNCHANGED
    assert second.vault_ref == first.vault_ref == _FRAGMENT_ID


@pytest.mark.asyncio
async def test_ingest_400_invalid_request_raises_a_contract_error(
    http_clients: ClientFactory,
) -> None:
    """A rejected payload is our bug, not the vault's absence, and carries its own code."""
    handler = _VaultRouteHandler(
        [
            _IngestReply(
                status=HTTPStatus.BAD_REQUEST,
                payload=_error_payload(VaultErrorCode.INVALID_REQUEST.value),
            )
        ]
    )
    client = await _handshaken_client(handler, http_clients)
    with pytest.raises(CreekVaultContractError) as exc_info:
        await client.ingest(_ingest_request())
    assert exc_info.value.code is VaultErrorCode.INVALID_REQUEST


@pytest.mark.asyncio
async def test_ingest_not_found_code_stays_a_contract_fault(
    http_clients: ClientFactory,
) -> None:
    """A routing code is adepthood's own bug, and learning to read it must not move it.

    Creek publishes ``not_found`` for a path this server does not serve, which is
    exactly the fault an uncoded 404 already reports. Teaching the error
    vocabulary that code must therefore leave the ingest answer where it was: a
    recognized code that fell into no contract set would silently reclassify a
    wrong URL as an absent vault.
    """
    handler = _VaultRouteHandler(
        [
            _IngestReply(
                status=HTTPStatus.NOT_FOUND,
                payload=_error_payload(VaultErrorCode.NOT_FOUND.value),
            )
        ]
    )
    client = await _handshaken_client(handler, http_clients)
    with pytest.raises(CreekVaultContractError) as exc_info:
        await client.ingest(_ingest_request())
    assert exc_info.value.code is VaultErrorCode.NOT_FOUND


@pytest.mark.parametrize(
    "status",
    [HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN],
    ids=["unauthorized", "forbidden"],
)
@pytest.mark.asyncio
async def test_ingest_401_raises_an_auth_error(
    status: HTTPStatus,
    http_clients: ClientFactory,
) -> None:
    """A rejected credential is a configuration fault, never reported as a missing vault."""
    handler = _VaultRouteHandler([_IngestReply(status=status, payload={"detail": "denied"})])
    client = await _handshaken_client(handler, http_clients)
    with pytest.raises(CreekVaultAuthError) as exc_info:
        await client.ingest(_ingest_request())
    assert not isinstance(exc_info.value, CreekVaultUnavailableError)
    assert isinstance(exc_info.value, CreekVaultError)


@pytest.mark.asyncio
async def test_ingest_temporarily_unavailable_code_raises_unavailable(
    http_clients: ClientFactory,
) -> None:
    """A vault naming itself temporarily unavailable is an availability fault, not a contract."""
    handler = _VaultRouteHandler(
        [
            _IngestReply(
                status=HTTPStatus.SERVICE_UNAVAILABLE,
                payload=_error_payload(VaultErrorCode.TEMPORARILY_UNAVAILABLE.value),
            )
        ]
    )
    client = await _handshaken_client(handler, http_clients)
    with pytest.raises(CreekVaultUnavailableError):
        await client.ingest(_ingest_request())


@pytest.mark.asyncio
async def test_ingest_connect_failure_raises_unavailable(
    http_clients: ClientFactory,
) -> None:
    """A vault that handshook and then went unreachable degrades rather than crashing."""
    handler = _VaultRouteHandler(ingest_error=httpx.ConnectError("refused"))
    client = await _handshaken_client(handler, http_clients)
    with pytest.raises(CreekVaultUnavailableError):
        await client.ingest(_ingest_request())


@pytest.mark.parametrize(
    ("reply", "expected"),
    [
        pytest.param(
            _IngestReply(status=HTTPStatus.BAD_REQUEST, payload={"detail": "nope"}),
            CreekVaultContractError,
            id="uncoded_400",
        ),
        pytest.param(
            _IngestReply(status=HTTPStatus.NOT_FOUND, payload={"detail": "nope"}),
            CreekVaultContractError,
            id="uncoded_404",
        ),
        pytest.param(
            _IngestReply(status=HTTPStatus.CONFLICT, payload={"detail": "nope"}),
            CreekVaultContractError,
            id="uncoded_409",
        ),
        pytest.param(
            _IngestReply(status=HTTPStatus.BAD_REQUEST, text="<html>Bad Request</html>"),
            CreekVaultContractError,
            id="non_json_4xx",
        ),
        pytest.param(
            _IngestReply(status=HTTPStatus.REQUEST_TIMEOUT, payload={"detail": "too slow"}),
            CreekVaultUnavailableError,
            id="uncoded_408_is_the_vaults_clock",
        ),
        pytest.param(
            _IngestReply(status=HTTPStatus.TOO_MANY_REQUESTS, payload={"detail": "slow down"}),
            CreekVaultUnavailableError,
            id="uncoded_429_is_throttling",
        ),
        pytest.param(
            _IngestReply(status=HTTPStatus.INTERNAL_SERVER_ERROR, payload={"detail": "boom"}),
            CreekVaultUnavailableError,
            id="uncoded_500",
        ),
        pytest.param(
            _IngestReply(status=HTTPStatus.BAD_GATEWAY, payload={"detail": "boom"}),
            CreekVaultUnavailableError,
            id="uncoded_502",
        ),
        pytest.param(
            _IngestReply(status=HTTPStatus.FOUND, payload={"detail": "elsewhere"}),
            CreekVaultUnavailableError,
            id="redirect_we_refuse_to_follow",
        ),
    ],
)
@pytest.mark.asyncio
async def test_ingest_classifies_an_uncoded_status_by_class(
    reply: _IngestReply,
    expected: type[CreekVaultError],
    http_clients: ClientFactory,
) -> None:
    """Uncoded, a 4xx is our contract fault -- except the two that describe the vault."""
    client = await _handshaken_client(_VaultRouteHandler([reply]), http_clients)
    with pytest.raises(expected) as exc_info:
        await client.ingest(_ingest_request())
    assert type(exc_info.value) is expected
    assert getattr(exc_info.value, "code", None) is None


@pytest.mark.asyncio
async def test_contract_and_unavailable_ingest_failures_are_distinguishable(
    http_clients: ClientFactory,
) -> None:
    """A bad payload and an unreachable vault raise two types, neither a subclass of the other."""
    contract_client = await _handshaken_client(
        _VaultRouteHandler(
            [
                _IngestReply(
                    status=HTTPStatus.BAD_REQUEST,
                    payload=_error_payload(VaultErrorCode.INVALID_REQUEST.value),
                )
            ]
        ),
        http_clients,
    )
    offline_client = await _handshaken_client(
        _VaultRouteHandler(ingest_error=httpx.ConnectError("refused")), http_clients
    )
    with pytest.raises(CreekVaultError) as contract_info:
        await contract_client.ingest(_ingest_request())
    with pytest.raises(CreekVaultError) as offline_info:
        await offline_client.ingest(_ingest_request())

    contract_error = contract_info.value
    offline_error = offline_info.value
    assert type(contract_error) is not type(offline_error)
    assert not isinstance(contract_error, type(offline_error))
    assert not isinstance(offline_error, type(contract_error))


@pytest.mark.asyncio
async def test_an_unrecognized_error_code_never_reaches_a_message_or_a_log(
    caplog: pytest.LogCaptureFixture,
    http_clients: ClientFactory,
) -> None:
    """A vault-supplied code is never parsed, stored, or echoed -- CRLF and all."""
    caplog.set_level(logging.DEBUG)
    handler = _VaultRouteHandler(
        [_IngestReply(status=HTTPStatus.BAD_REQUEST, payload=_error_payload(_HOSTILE_VAULT_CODE))]
    )
    client = await _handshaken_client(handler, http_clients)
    with pytest.raises(CreekVaultContractError) as exc_info:
        await client.ingest(_ingest_request())

    assert exc_info.value.code is None
    for rendered in (str(exc_info.value), repr(exc_info.value), caplog.text):
        assert _HOSTILE_CODE_SENTINEL not in rendered
        assert "\r\n" not in rendered


@pytest.mark.asyncio
async def test_ingest_is_bounded_by_the_whole_request_deadline(
    monkeypatch: pytest.MonkeyPatch,
    http_clients: ClientFactory,
) -> None:
    """An ingest that outlives the deadline degrades to unavailable rather than hanging."""
    monkeypatch.setattr(_DEADLINE_ATTR, _TINY_DEADLINE_SECONDS)
    client = await _handshaken_client(_SlowIngestHandler(), http_clients)
    with pytest.raises(CreekVaultUnavailableError):
        await client.ingest(_ingest_request())


@pytest.mark.asyncio
async def test_ingest_refuses_when_journal_was_not_advertised(
    http_clients: ClientFactory,
) -> None:
    """An unadvertised journal capability refuses locally: no entry body ever leaves."""
    handler = _VaultRouteHandler(capabilities=[CreekCapability.REFLECT.value])
    client = await _handshaken_client(handler, http_clients)
    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.ingest(_ingest_request())
    assert handler.ingest_requests == []


@pytest.mark.asyncio
async def test_entry_body_and_api_key_never_leak_from_any_ingest_failure(
    caplog: pytest.LogCaptureFixture,
    http_clients: ClientFactory,
) -> None:
    """No ingest path -- contract, auth, unavailable, or success -- echoes the body or the key."""
    caplog.set_level(logging.DEBUG)
    replies = {
        "contract": _IngestReply(
            status=HTTPStatus.BAD_REQUEST,
            payload=_error_payload(VaultErrorCode.INVALID_REQUEST.value),
        ),
        "auth": _IngestReply(status=HTTPStatus.UNAUTHORIZED, payload={"detail": "denied"}),
        "unavailable": _IngestReply(
            status=HTTPStatus.INTERNAL_SERVER_ERROR, payload={"detail": "boom"}
        ),
    }
    raised: list[CreekVaultError] = []
    for reply in replies.values():
        client = await _handshaken_client(_VaultRouteHandler([reply]), http_clients, _SENTINEL_KEY)
        with pytest.raises(CreekVaultError) as exc_info:
            await client.ingest(_ingest_request(body=_SENTINEL_BODY))
        raised.append(exc_info.value)
    stored = await _handshaken_client(_VaultRouteHandler(), http_clients, _SENTINEL_KEY)
    assert (await stored.ingest(_ingest_request(body=_SENTINEL_BODY))).stored is True

    assert len(raised) == len(replies)
    for error in raised:
        for rendered in (str(error), repr(error)):
            assert _SENTINEL_BODY not in rendered
            assert _SENTINEL_KEY not in rendered
        assert error.__cause__ is None
        assert error.__suppress_context__ is True
    assert _SENTINEL_BODY not in caplog.text
    assert _SENTINEL_KEY not in caplog.text


@pytest.mark.asyncio
async def test_intimate_entry_issues_zero_http_requests(
    http_clients: ClientFactory,
) -> None:
    """An intimate entry never reaches the wire -- the transport spy sees nothing at all."""
    handler = _VaultRouteHandler()
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    outcome = await store_and_classify(
        client,
        entry_id=_ENTRY_ID,
        body=_SENTINEL_BODY,
        classification="intimate",
        created_at=_CREATED_AT,
    )
    assert outcome.status is VaultWriteStatus.SKIPPED_INTIMATE
    assert handler.requests == []


@pytest.mark.asyncio
async def test_unknown_classification_sends_nothing_over_http(
    http_clients: ClientFactory,
) -> None:
    """An unrecognized classification fails closed before a single byte is sent."""
    handler = _VaultRouteHandler()
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    with pytest.raises(ValueError, match="bogus"):
        await store_and_classify(
            client,
            entry_id=_ENTRY_ID,
            body=_SENTINEL_BODY,
            classification="bogus",
            created_at=_CREATED_AT,
        )
    assert handler.requests == []


@pytest.mark.asyncio
async def test_handshake_degrades_when_httpx_cannot_parse_the_vault_url(
    http_clients: ClientFactory,
) -> None:
    """A vault URL httpx refuses to build a request for is unreachable, not a crash."""
    handler = _VaultRouteHandler()
    client = HttpCreekVaultClient(
        _UNPARSEABLE_VAULT_URL, _API_KEY, http_client=http_clients(handler)
    )
    result = await client.handshake()
    assert result.available is False
    assert client.last_degrade_reason is HandshakeDegradeReason.UNREACHABLE
    assert handler.requests == []


@pytest.mark.asyncio
async def test_write_path_degrades_when_httpx_cannot_parse_the_vault_url(
    http_clients: ClientFactory,
) -> None:
    """A misconfigured vault URL degrades the write instead of raising into the caller.

    ``httpx.InvalidURL`` sits outside the ``HTTPError`` hierarchy, so it is the
    one transport-layer failure that could escape the seam and turn a saved
    entry into a 500 for the user who saved it.
    """
    handler = _VaultRouteHandler()
    client = HttpCreekVaultClient(
        _UNPARSEABLE_VAULT_URL, _API_KEY, http_client=http_clients(handler)
    )
    outcome = await store_and_classify(
        client,
        entry_id=_ENTRY_ID,
        body=_SENTINEL_BODY,
        classification="public",
        created_at=_CREATED_AT,
    )
    assert outcome.status is VaultWriteStatus.UNAVAILABLE
    assert handler.requests == []


@pytest.mark.asyncio
async def test_write_path_ingests_over_http_end_to_end(
    http_clients: ClientFactory,
) -> None:
    """A healthy vault plus a successful PUT carries the write all the way to INGESTED."""
    handler = _VaultRouteHandler()
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))
    outcome = await store_and_classify(
        client,
        entry_id=_ENTRY_ID,
        body=_ENTRY_BODY,
        classification="public",
        created_at=_CREATED_AT,
    )
    assert outcome.status is VaultWriteStatus.INGESTED
    assert outcome.vault_ref == _FRAGMENT_ID
    assert _sent_ingest_body(handler)["tier"] == VaultTierCeiling.OPEN.value


@pytest.mark.asyncio
async def test_http_wheel_success_projects_the_ratified_frequencies(
    http_clients: ClientFactory,
) -> None:
    """Creek's published wheel body reads back as ten aspects carrying its own numbers.

    ``F{n}`` is adepthood's stage ``n`` and the share is the fullness verbatim:
    the adapter projects, it does not rescale, and a rounding step here would be
    invisible in every rendered wheel afterwards.
    """
    published = _wheel_example("success")
    frequencies = _wheel_frequencies(published)
    handler = _WheelRouteHandler(published)
    client = await _handshaken_client(handler, http_clients)

    balance = await client.wheel()

    assert [aspect.stage_number for aspect in balance.aspects] == list(range(1, TOTAL_STAGES + 1))
    for aspect in balance.aspects:
        entry = frequencies[f"F{aspect.stage_number}"]
        assert aspect.fullness == entry["share"]
        assert aspect.aspect == entry["name"]

    assert len(handler.wheel_requests) == 1
    read = handler.wheel_requests[0]
    assert read.method == "GET"
    assert str(read.url) == _WHEEL_URL
    assert read.url.query == b""
    assert read.content == b""
    assert read.headers["Authorization"] == f"Bearer {_API_KEY}"


@pytest.mark.asyncio
async def test_http_wheel_requires_the_advertised_capability_without_egress(
    http_clients: ClientFactory,
) -> None:
    """A vault that never advertised the wheel is refused locally, before any request."""
    handler = _WheelRouteHandler(_wheel_example("success"))
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(handler))

    with pytest.raises(CreekCapabilityUnsupportedError) as exc_info:
        await client.wheel()

    assert CreekCapability.WHEEL.value in str(exc_info.value)
    assert handler.requests == []


@pytest.mark.parametrize(
    "ceiling",
    [VaultTierCeiling.INTIMATE.value, "not-a-tier"],
    ids=["above_our_ceiling", "unrecognized_ceiling"],
)
@pytest.mark.asyncio
async def test_http_wheel_rejects_a_payload_whose_tier_echo_exceeds_our_ceiling(
    ceiling: str,
    http_clients: ClientFactory,
) -> None:
    """The echoed ceiling is verified, not trusted: a wider one discards the whole read.

    The ratified surface publishes no way to declare a ceiling, so the only
    control left is to check the one the vault says it applied. A tally counted
    above the tier adepthood may ever see is not a wheel this app can render.
    """
    handler = _WheelRouteHandler(_wheel_with_ceiling(ceiling))
    client = await _handshaken_client(handler, http_clients)

    with pytest.raises(CreekVaultPayloadError):
        await client.wheel()


@pytest.mark.parametrize(
    "ceiling",
    [VaultTierCeiling.OPEN.value, VaultTierCeiling.PERSONAL.value],
    ids=["open", "personal"],
)
@pytest.mark.asyncio
async def test_http_wheel_accepts_both_admissible_tier_echoes(
    ceiling: str,
    http_clients: ClientFactory,
) -> None:
    """Both ceilings a remote caller may reach are admissible echoes, not just the default."""
    assert _wheel_example("success")["tier_ceiling"] == VaultTierCeiling.OPEN.value
    handler = _WheelRouteHandler(_wheel_with_ceiling(ceiling))
    client = await _handshaken_client(handler, http_clients)

    balance = await client.wheel()

    assert len(balance.aspects) == TOTAL_STAGES


@pytest.mark.parametrize(
    ("state", "status", "expected", "code"),
    [
        pytest.param(
            "refusal",
            HTTPStatus.FORBIDDEN,
            CreekVaultContractError,
            VaultErrorCode.PRIVACY_REFUSED,
            id="refusal_403_is_a_privacy_refusal",
        ),
        pytest.param(
            "malformed-input",
            HTTPStatus.UNPROCESSABLE_ENTITY,
            CreekVaultContractError,
            VaultErrorCode.INVALID_REQUEST,
            id="malformed_input_422",
        ),
        pytest.param(
            "incompatible-version",
            HTTPStatus.CONFLICT,
            CreekVaultContractError,
            VaultErrorCode.INCOMPATIBLE_VERSION,
            id="incompatible_version_409",
        ),
        pytest.param(
            "unavailable-service",
            HTTPStatus.SERVICE_UNAVAILABLE,
            CreekVaultUnavailableError,
            VaultErrorCode.UNAVAILABLE,
            id="unavailable_service_503",
        ),
    ],
)
@pytest.mark.asyncio
async def test_http_wheel_error_states_are_classified_from_the_published_code(
    state: str,
    status: HTTPStatus,
    expected: type[CreekVaultError],
    code: VaultErrorCode,
    http_clients: ClientFactory,
) -> None:
    """Every published wheel error cell is classified from its code, never from its status.

    The 403 is the whole reason for that order. Creek publishes
    ``privacy_refused`` there, and deciding on the status alone would report a
    refusal as a rejected credential -- sending an operator to rotate a key that
    was never refused.
    """
    handler = _WheelRouteHandler(_wheel_example(state), status)
    client = await _handshaken_client(handler, http_clients)

    with pytest.raises(expected) as exc_info:
        await client.wheel()

    assert type(exc_info.value) is expected
    assert getattr(exc_info.value, "code", None) is code
    assert not isinstance(exc_info.value, CreekVaultAuthError)


@pytest.mark.asyncio
async def test_http_wheel_uncoded_credential_rejection_is_an_auth_error(
    http_clients: ClientFactory,
) -> None:
    """With no readable code, a refused credential is still a credential to rotate."""
    handler = _WheelRouteHandler({"detail": "denied"}, HTTPStatus.UNAUTHORIZED)
    client = await _handshaken_client(handler, http_clients)

    with pytest.raises(CreekVaultAuthError) as exc_info:
        await client.wheel()

    assert type(exc_info.value) is CreekVaultAuthError


@pytest.mark.parametrize(
    "handler",
    [
        pytest.param(
            _WheelRouteHandler(text="<html><body>Bad Gateway</body></html>"),
            id="body_is_not_json",
        ),
        pytest.param(_WheelRouteHandler([1, 2, 3]), id="json_is_not_an_object"),
        pytest.param(
            _WheelRouteHandler(_wheel_without_frequency("F7")),
            id="nine_frequencies_instead_of_ten",
        ),
        pytest.param(_WheelRouteHandler(_wheel_with_share("F3", "0.1")), id="share_is_a_string"),
        *[
            pytest.param(_WheelRouteHandler(_wheel_without_key(key)), id=f"missing_{key}")
            for key in _wheel_required_keys()
        ],
    ],
)
@pytest.mark.asyncio
async def test_http_wheel_malformed_success_bodies_are_payload_errors(
    handler: _WheelRouteHandler,
    http_clients: ClientFactory,
) -> None:
    """A 200 adepthood cannot read is a payload fault, all-or-nothing.

    One unusable Frequency rejects the whole read rather than yielding a ring
    with a hole in it, and a missing published field is not completed with a
    default the vault never sent.
    """
    client = await _handshaken_client(handler, http_clients)

    with pytest.raises(CreekVaultPayloadError):
        await client.wheel()


@pytest.mark.asyncio
async def test_http_wheel_transport_failure_is_unavailable_not_payload(
    http_clients: ClientFactory,
) -> None:
    """A vault that was not there is not a vault that answered badly.

    This is the pair that makes the new payload type worth having: schema failure
    and vault absence must stay separately countable, since one is a vault bug to
    report upstream and the other is infrastructure to restore.
    """
    handler = _WheelRouteHandler(wheel_error=httpx.ConnectError("refused"))
    client = await _handshaken_client(handler, http_clients)

    with pytest.raises(CreekVaultUnavailableError) as exc_info:
        await client.wheel()

    assert type(exc_info.value) is CreekVaultUnavailableError
    assert not isinstance(exc_info.value, CreekVaultPayloadError)


@pytest.mark.parametrize(
    ("handler", "expected"),
    [
        pytest.param(
            _WheelRouteHandler({"status": _HOSTILE_VAULT_CODE}),
            CreekVaultPayloadError,
            id="payload",
        ),
        pytest.param(
            _WheelRouteHandler(
                _error_payload(_HOSTILE_VAULT_CODE), HTTPStatus.UNPROCESSABLE_ENTITY
            ),
            CreekVaultContractError,
            id="contract",
        ),
        pytest.param(
            _WheelRouteHandler(_error_payload(_HOSTILE_VAULT_CODE), HTTPStatus.UNAUTHORIZED),
            CreekVaultAuthError,
            id="auth",
        ),
    ],
)
@pytest.mark.asyncio
async def test_http_wheel_failures_never_carry_vault_text_or_the_credential(
    handler: _WheelRouteHandler,
    expected: type[CreekVaultError],
    http_clients: ClientFactory,
) -> None:
    """No wheel failure echoes the credential or a string the vault chose.

    An unrecognized code is dropped rather than stored, and nothing rides along
    as a cause or a context: an exception raised inside a parse ``except`` would
    carry the vault's own decoder text into every traceback that renders it.
    """
    client = await _handshaken_client(handler, http_clients, _SENTINEL_KEY)

    with pytest.raises(expected) as exc_info:
        await client.wheel()

    error = exc_info.value
    for rendered in (str(error), repr(error)):
        assert _SENTINEL_KEY not in rendered
        assert _HOSTILE_CODE_SENTINEL not in rendered
        assert "\r\n" not in rendered
    assert error.__cause__ is None
    assert error.__context__ is None
