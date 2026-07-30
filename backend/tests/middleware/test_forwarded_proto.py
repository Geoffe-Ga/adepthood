"""Forwarded-proto resolution: the scheme is evidence only from a trusted peer.

``X-Forwarded-Proto`` is written by whoever is talking to us, so honouring it
unconditionally lets any caller declare its plaintext request was TLS-protected
-- which flips ``request.url.scheme`` and, with it, every absolute URL the
application mints.  These tests pin an application middleware that reuses the
same ``TRUSTED_PROXY_CIDRS`` trust walk :mod:`client_ip` already performs: an
unvouched peer, an unset allowlist, or a value that is not a bare scheme token
all leave the socket scheme exactly as the server saw it.

The probe app below fakes the ASGI socket peer through ``ASGITransport`` and
reports the scheme a route observes.  Two cases drive the real application
instead and read the ``Location`` of a trailing-slash redirect, because that
redirect must not downgrade a client from HTTPS to HTTP behind a
TLS-terminating proxy.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from http import HTTPStatus
from typing import TYPE_CHECKING

import pytest
from fastapi import FastAPI, Request
from httpx import ASGITransport, AsyncClient

from client_ip import TRUSTED_PROXIES_ENV_VAR
from main import app
from middleware import ForwardedProtoMiddleware

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from starlette.types import Message, Scope

# Documentation-range addresses (RFC 5737) matching the trust tests in
# ``tests/security/test_client_ip.py``, so no case can be mistaken for a real
# network and both suites describe the same allowlist.
_TRUSTED_PROXY_NET = "192.0.2.0/24"
_PROXY_PEER = "192.0.2.10"
_UNTRUSTED_PEER = "198.51.100.7"
_PEER_PORT = 51_234

_FORWARDED_PROTO_HEADER = "X-Forwarded-Proto"
_FORWARDED_FOR_HEADER = "X-Forwarded-For"
_HTTP = "http"
_HTTPS = "https"

# A forwarded chain naming somebody other than the socket peer, so a middleware
# that copied uvicorn's client rewriting would visibly change the reported peer.
_FORWARDED_CLIENT_IP = "203.0.113.5"

# The probe app's routes, and the keys they report the observed scope under.
_SCHEME_PATH = "/scheme"
_SCHEME_KEY = "scheme"
_PEER_PATH = "/peer"
_PEER_KEY = "peer"

# The answer the peer route gives when the scope carries no client at all, so a
# missing peer cannot be mistaken for a rewritten one.
_NO_PEER = "none"

# ``base_url`` decides the socket scheme the transport writes into the scope,
# so every case starts from plaintext and the middleware is the only thing that
# could raise it.
_BASE_URL = "http://test"

# A collection route whose canonical form carries a trailing slash, so the
# router answers 307 before any dependency or auth check runs.
_COLLECTION_PATH = "/practices"
_LOCATION_HEADER = "location"
_HTTPS_LOCATION_PREFIX = "https://"
_HTTP_LOCATION_PREFIX = "http://"

# Values that are not a bare scheme token: junk, an absolute URL, nothing at
# all, and a token with an interior space.
_UNKNOWN_SCHEME_VALUES = ["gopher", "https://evil.example", "", "HTTP S"]

# A proxy chain, which this middleware deliberately does not split.
_APPENDED_PROTO_CHAIN = "https, http"

_UPPERCASE_HTTPS = "HTTPS"

# Non-HTTP scope fixtures: a scheme value no ASGI server would ever set, so an
# assertion on it can only pass if the middleware left the mapping alone.
_LIFESPAN_SCOPE_TYPE = "lifespan"
_LIFESPAN_STARTUP_MESSAGE_TYPE = "lifespan.startup"
_SCOPE_TYPE_KEY = "type"
_SCOPE_HEADERS_KEY = "headers"
_SENTINEL_SCHEME = "sentinel-scheme"
_SPOOFED_PROTO_HEADERS = [(b"x-forwarded-proto", _HTTPS.encode())]

_probe = FastAPI()


@_probe.get(_SCHEME_PATH)
async def _report_scheme(request: Request) -> dict[str, str]:
    """Report the scheme the middleware left on the ASGI scope."""
    return {_SCHEME_KEY: request.url.scheme}


@_probe.get(_PEER_PATH)
async def _report_peer(request: Request) -> dict[str, str]:
    """Report the socket peer the middleware left on the ASGI scope."""
    peer = request.client
    return {_PEER_KEY: _NO_PEER if peer is None else peer.host}


_probe.add_middleware(ForwardedProtoMiddleware)


@asynccontextmanager
async def _peer_client(target: FastAPI, peer_host: str) -> AsyncIterator[AsyncClient]:
    """Yield a plaintext client for ``target`` whose ASGI socket peer is ``peer_host``."""
    transport = ASGITransport(app=target, client=(peer_host, _PEER_PORT))
    async with AsyncClient(transport=transport, base_url=_BASE_URL) as client:
        yield client


async def _observed_scheme(peer_host: str, forwarded: list[str]) -> str:
    """Return the scheme the probe route saw, given one field line per entry.

    A proxy that appends its own ``X-Forwarded-Proto`` rather than replacing the
    caller's produces several field lines, so the list models a real chain.
    """
    headers = [(_FORWARDED_PROTO_HEADER, value) for value in forwarded]
    async with _peer_client(_probe, peer_host) as client:
        response = await client.get(_SCHEME_PATH, headers=headers)
    assert response.status_code == HTTPStatus.OK
    return str(response.json()[_SCHEME_KEY])


async def _observed_peer(peer_host: str, forwarded_for: str) -> str:
    """Return the socket peer the probe route saw, given a forwarded-for chain."""
    headers = {_FORWARDED_FOR_HEADER: forwarded_for, _FORWARDED_PROTO_HEADER: _HTTPS}
    async with _peer_client(_probe, peer_host) as client:
        response = await client.get(_PEER_PATH, headers=headers)
    assert response.status_code == HTTPStatus.OK
    return str(response.json()[_PEER_KEY])


@pytest.mark.asyncio
async def test_trusted_proxy_forwarded_proto_upgrades_the_scheme(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A peer inside the allowlist may report that it terminated TLS for the client."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    scheme = await _observed_scheme(_PROXY_PEER, [_HTTPS])

    assert scheme == _HTTPS


@pytest.mark.asyncio
@pytest.mark.parametrize("peer_host", [_PROXY_PEER, _UNTRUSTED_PEER])
async def test_resolving_the_scheme_never_rewrites_the_socket_peer(
    monkeypatch: pytest.MonkeyPatch,
    peer_host: str,
) -> None:
    """Settling the scheme leaves the peer alone, trusted or not.

    Deciding who the client is belongs to the resolver, at the moment a throttle
    or an audit row asks; a layer that answered it here from the same forwarded
    headers would be the server-side rewriting this change exists to remove.
    """
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    peer = await _observed_peer(peer_host, _FORWARDED_CLIENT_IP)

    assert peer == peer_host


@pytest.mark.asyncio
async def test_untrusted_peer_cannot_upgrade_the_scheme(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A peer outside the allowlist keeps the scheme the socket actually carried."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    scheme = await _observed_scheme(_UNTRUSTED_PEER, [_HTTPS])

    assert scheme == _HTTP


@pytest.mark.asyncio
async def test_unconfigured_allowlist_ignores_the_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With no allowlist configured nobody is a proxy, so the header is evidence of nothing."""
    monkeypatch.delenv(TRUSTED_PROXIES_ENV_VAR, raising=False)

    scheme = await _observed_scheme(_PROXY_PEER, [_HTTPS])

    assert scheme == _HTTP


@pytest.mark.asyncio
async def test_trusted_proxy_without_the_header_keeps_the_socket_scheme(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A vouched peer that says nothing about the scheme changes nothing."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    scheme = await _observed_scheme(_PROXY_PEER, [])

    assert scheme == _HTTP


@pytest.mark.asyncio
@pytest.mark.parametrize("forwarded_value", _UNKNOWN_SCHEME_VALUES)
async def test_unknown_scheme_value_is_ignored(
    monkeypatch: pytest.MonkeyPatch,
    forwarded_value: str,
) -> None:
    """Only a bare scheme token is accepted; anything else leaves the socket scheme."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    scheme = await _observed_scheme(_PROXY_PEER, [forwarded_value])

    assert scheme == _HTTP


@pytest.mark.asyncio
async def test_uppercase_scheme_value_is_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    """Scheme tokens are case-insensitive, so a shouting proxy is still understood."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    scheme = await _observed_scheme(_PROXY_PEER, [_UPPERCASE_HTTPS])

    assert scheme == _HTTPS


@pytest.mark.asyncio
async def test_appended_proto_chain_is_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    """A comma-joined chain is not a scheme, and is deliberately not split apart.

    This is uvicorn's own reading, and it fails closed: the caller controls the
    left of any chain it can get merged into one field line, so splitting would
    hand it a way to author the value.  Refusing the whole line costs a
    misconfigured deployment its scheme upgrade and costs an attacker the
    forgery.
    """
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    scheme = await _observed_scheme(_PROXY_PEER, [_APPENDED_PROTO_CHAIN])

    assert scheme == _HTTP


@pytest.mark.asyncio
async def test_last_forwarded_proto_line_wins_over_a_client_prepended_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The proxy appends its line last, so the last line is the only authored one.

    Reading the first line -- which is what a plain header lookup returns --
    hands a caller that sent its own ``X-Forwarded-Proto`` authorship of the
    scheme, exactly as a left-most ``X-Forwarded-For`` read hands it the client
    address.
    """
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    prepended_https = await _observed_scheme(_PROXY_PEER, [_HTTPS, _HTTP])
    prepended_http = await _observed_scheme(_PROXY_PEER, [_HTTP, _HTTPS])

    assert prepended_https == _HTTP
    assert prepended_http == _HTTPS


@pytest.mark.asyncio
async def test_trusted_proxy_may_also_report_plain_http(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An accepted value that matches the socket scheme is honoured and changes nothing."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    scheme = await _observed_scheme(_PROXY_PEER, [_HTTP])

    assert scheme == _HTTP


class _ScopeRecorder:
    """A stub ASGI app that records the scope object it was handed."""

    def __init__(self) -> None:
        """Start out having seen nothing."""
        self.seen: Scope | None = None

    async def __call__(self, scope: Scope, _receive: object, _send: object) -> None:
        """Record ``scope`` by identity and do nothing else."""
        self.seen = scope


async def _empty_receive() -> Message:
    """Return one ASGI message; the pass-through case never reads the stream."""
    return {_SCOPE_TYPE_KEY: _LIFESPAN_STARTUP_MESSAGE_TYPE}


async def _discard_send(_message: Message) -> None:
    """Drop an outbound ASGI message."""


@pytest.mark.asyncio
async def test_non_http_scope_passes_through_untouched(monkeypatch: pytest.MonkeyPatch) -> None:
    """Scopes that are not HTTP requests reach the inner app byte-for-byte unchanged."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)
    recorder = _ScopeRecorder()
    scope = {
        _SCOPE_TYPE_KEY: _LIFESPAN_SCOPE_TYPE,
        _SCHEME_KEY: _SENTINEL_SCHEME,
        _SCOPE_HEADERS_KEY: _SPOOFED_PROTO_HEADERS,
        "client": (_PROXY_PEER, _PEER_PORT),
    }

    await ForwardedProtoMiddleware(recorder)(scope, _empty_receive, _discard_send)

    assert recorder.seen is scope
    assert scope[_SCHEME_KEY] == _SENTINEL_SCHEME


async def _redirect_location(peer_host: str, forwarded: str) -> tuple[int, str]:
    """Return the status and ``Location`` of the real app's trailing-slash redirect."""
    async with _peer_client(app, peer_host) as client:
        response = await client.get(
            _COLLECTION_PATH,
            headers={_FORWARDED_PROTO_HEADER: forwarded},
        )
    return response.status_code, response.headers[_LOCATION_HEADER]


@pytest.mark.asyncio
async def test_trailing_slash_redirect_emits_https_location_for_a_trusted_proxy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Behind a TLS-terminating proxy the router's own redirect must stay on HTTPS.

    A redirect that names ``http://`` sends the browser back over plaintext,
    which either breaks under a strict-transport policy or leaks the request.
    """
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    status, location = await _redirect_location(_PROXY_PEER, _HTTPS)

    assert status == HTTPStatus.TEMPORARY_REDIRECT
    assert location.startswith(_HTTPS_LOCATION_PREFIX)


@pytest.mark.asyncio
async def test_trailing_slash_redirect_stays_http_for_an_untrusted_peer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unvouched caller cannot talk the router into minting HTTPS absolute URLs."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    status, location = await _redirect_location(_UNTRUSTED_PEER, _HTTPS)

    assert status == HTTPStatus.TEMPORARY_REDIRECT
    assert location.startswith(_HTTP_LOCATION_PREFIX)
