"""Throttle keys must group an IPv6 client by its delegated prefix, not its address.

A residential IPv6 customer is handed a whole /64, so a single subscriber owns
2**64 source addresses and can present a fresh one on every request.  Keying a
throttle on the full address therefore hands that subscriber 2**64 independent
buckets and no hourly cap can ever trip.  IPv4 has no such gift -- one client,
one address -- so grouping IPv4 by prefix would only make unrelated customers
behind one carrier NAT throttle each other.

The answer is a deliberate split of one question into two: ``resolve_client_ip``
keeps answering "who was this, exactly" for audit rows, while
``client_throttle_key`` answers "whose budget does this spend".  These tests pin
both halves and, crucially, pin that they do not silently converge.

The harness below duplicates a little of the audit-contract suite on purpose:
that suite is the regression proof for the audit answer and must stay
independent of anything the throttle answer does.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from http import HTTPStatus
from typing import TYPE_CHECKING

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.requests import Request

from client_ip import (
    DEFAULT_IPV6_THROTTLE_PREFIX_LEN,
    IPV6_THROTTLE_PREFIX_ENV_VAR,
    TRUSTED_PROXIES_ENV_VAR,
    client_throttle_key,
    resolve_client_ip,
)
from database import get_session
from main import app
from rate_limit import INVALID_LICENSE_MAX_PER_HOUR

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from httpx import Response
    from sqlalchemy.ext.asyncio import AsyncSession

# Documentation-range addresses only (RFC 5737 for IPv4, RFC 3849 for IPv6) so
# no case can be mistaken for traffic on a real network.
_TRUSTED_PROXY_NET = "192.0.2.0/24"
_PROXY_PEER = "192.0.2.10"
_UNTRUSTED_PEER = "198.51.100.7"
_IPV4_CLIENT = "203.0.113.5"
# Same /24 as the client above: proof that IPv4 is NOT grouped by prefix.
_IPV4_SAME_SLASH_24 = "203.0.113.9"
# A dual-stack listener reports an IPv4 connection in this mapped form.
_MAPPED_IPV4_CLIENT = f"::ffff:{_IPV4_CLIENT}"
_PEER_PORT = 51_234

# Two addresses a single subscriber can present from one delegated /64, and the
# prefix both must collapse onto.  The literal is the point: both limiter
# backends compare keys for byte equality, so the textual form is the contract.
_IPV6_CLIENT = "2001:db8:1:1::1"
_IPV6_SAME_SLASH_64 = "2001:db8:1:1:ffff::2"
_IPV6_CLIENT_KEY = "2001:db8:1:1::/64"  # pragma: allowlist secret

# A genuinely different subscriber: adjacent /64, must never share a budget.
_IPV6_OTHER_CLIENT = "2001:db8:1:2::1"
_IPV6_OTHER_CLIENT_KEY = "2001:db8:1:2::/64"  # pragma: allowlist secret

# Widening the prefix is an operator decision, so it is configuration.  At /56
# the first two addresses merge and the third stays separate.
_WIDER_PREFIX_LEN = "56"
_IPV6_SAME_SLASH_56 = "2001:db8:1:5f::1"
_IPV6_OUTSIDE_SLASH_56 = "2001:db8:1:100::1"
_IPV6_WIDE_KEY = "2001:db8:1::/56"
_IPV6_OUTSIDE_WIDE_KEY = "2001:db8:1:100::/56"

# A prefix length that is not an integer in [1, 128] is an operator typo, and
# ``0`` in particular would collapse every IPv6 client on earth into one bucket.
# Degrading to the known-good default is the only safe reading of any of them.
_INVALID_PREFIX_LENGTHS = ["abc", "", "0", "-1", "129", "64.5"]

# The answer for any peer that cannot be turned into an IP literal.
_UNKNOWN_CLIENT = "unknown"
_MALFORMED_PEER = "not-an-ip"

# ``ipaddress`` accepts a zone id of any length, so a hop can parse cleanly and
# still be unboundedly wide; a zone id also names an interface on one machine
# and so cannot identify anyone across a proxy hop.
_OVERLONG_ZONE_LENGTH = 200
_LONG_ZONE_ID = "z" * _OVERLONG_ZONE_LENGTH
_SCOPED_IPV6_HOP = f"fe80::1%{_LONG_ZONE_ID}"

# The widest key the split can legitimately produce: a fully expanded IPv6
# literal (39 chars) plus the longest prefix suffix ("/128").
_MAX_THROTTLE_KEY_LENGTH = 43

_CIDR_MARKER = "/"

_SIGNUP_PATH = "/auth/signup"
_SIGNUP_PASSWORD = "securepassword123"  # pragma: allowlist secret
_LICENSE_KEY = "ABCD1234-EF56-7890-TEST"  # pragma: allowlist secret
_PRODUCT_IDS_ENV_VAR = "GUMROAD_APTITUDE_PRODUCT_IDS"
_ALLOWLISTED_PRODUCT = "prod_alpha"
_VERIFY_SEAM = "domain.entitlements.verify_license"
_DETAIL_INVALID_LICENSE = "invalid_license"
_DETAIL_THROTTLED = "too_many_license_attempts"

_RESET_PATH = "/auth/password-reset/request"
_RESET_REQUESTS_PER_HOUR = 3
_UNREGISTERED_EMAIL = "nobody@example.com"


def _make_request(peer: tuple[str, int] | None, forwarded: str | None = None) -> Request:
    """Build a bare ASGI request with the given socket peer and forwarded header."""
    headers = [] if forwarded is None else [(b"x-forwarded-for", forwarded.encode())]
    return Request({"type": "http", "headers": headers, "client": peer})


def _proxied(monkeypatch: pytest.MonkeyPatch, forwarded: str) -> Request:
    """Return a request from ``forwarded`` arriving through a trusted proxy."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)
    return _make_request((_PROXY_PEER, _PEER_PORT), forwarded)


def test_addresses_in_one_delegated_prefix_share_a_throttle_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two addresses from one subscriber's /64 must spend one budget.

    The expected value is asserted as a literal because both limiter backends
    compare keys for byte equality: an equivalent network object rendered any
    other way would silently mint a second bucket.
    """
    first = client_throttle_key(_proxied(monkeypatch, _IPV6_CLIENT))
    second = client_throttle_key(_proxied(monkeypatch, _IPV6_SAME_SLASH_64))

    assert first == _IPV6_CLIENT_KEY
    assert second == _IPV6_CLIENT_KEY


def test_addresses_in_different_prefixes_get_different_throttle_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Separate /64s are separate subscribers, so exhausting one must not touch the other."""
    first = client_throttle_key(_proxied(monkeypatch, _IPV6_CLIENT))
    second = client_throttle_key(_proxied(monkeypatch, _IPV6_OTHER_CLIENT))

    assert first == _IPV6_CLIENT_KEY
    assert second == _IPV6_OTHER_CLIENT_KEY
    assert first != second


def test_ipv4_throttle_key_is_the_resolved_address_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """IPv4 clients own one address each, so the throttle key stays the address.

    Grouping IPv4 by prefix would make every unrelated customer behind one
    carrier NAT share a budget -- a denial of service dressed as a fix.
    """
    request = _proxied(monkeypatch, _IPV4_CLIENT)

    assert client_throttle_key(request) == resolve_client_ip(request)
    assert client_throttle_key(request) == _IPV4_CLIENT


def test_ipv4_neighbours_in_one_slash_24_keep_separate_throttle_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two IPv4 addresses in one /24 are two customers and must not be merged."""
    first = client_throttle_key(_proxied(monkeypatch, _IPV4_CLIENT))
    second = client_throttle_key(_proxied(monkeypatch, _IPV4_SAME_SLASH_24))

    assert first == _IPV4_CLIENT
    assert second == _IPV4_SAME_SLASH_24
    assert first != second


def test_ipv4_mapped_literal_takes_the_ipv4_throttle_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A mapped literal is an IPv4 host wearing IPv6 syntax; prefixing it would be wrong.

    Treating it as IPv6 would group the whole ``::ffff:0:0/96`` mapped range,
    i.e. the entire IPv4 internet, into a single throttle bucket.
    """
    mapped = client_throttle_key(_proxied(monkeypatch, _MAPPED_IPV4_CLIENT))
    plain = client_throttle_key(_proxied(monkeypatch, _IPV4_CLIENT))

    assert mapped == _IPV4_CLIENT
    assert mapped == plain
    assert _CIDR_MARKER not in mapped


@pytest.mark.parametrize("peer", [None, (_MALFORMED_PEER, _PEER_PORT)])
def test_unkeyable_peer_yields_the_same_unknown_answer_as_the_resolver(
    monkeypatch: pytest.MonkeyPatch,
    peer: tuple[str, int] | None,
) -> None:
    """No keyable peer must degrade to a constant, never crash the request."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)
    request = _make_request(peer, _IPV6_CLIENT)

    assert client_throttle_key(request) == _UNKNOWN_CLIENT
    assert client_throttle_key(request) == resolve_client_ip(request)


def test_scoped_ipv6_hop_neither_crashes_nor_widens_the_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A zone id parses as an address but identifies nobody across a proxy hop.

    Accepting it would key on an unbounded attacker-chosen string; the request
    must fall back to the socket peer instead.
    """
    key = client_throttle_key(_proxied(monkeypatch, _SCOPED_IPV6_HOP))

    assert key == _PROXY_PEER
    assert _LONG_ZONE_ID not in key
    assert len(key) <= _MAX_THROTTLE_KEY_LENGTH


def test_audit_answer_and_throttle_answer_do_not_converge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One request, two answers: the audit trail keeps the address, the throttle the prefix.

    Asserted together so a future refactor cannot quietly collapse the split
    back into one function without a test noticing.
    """
    request = _proxied(monkeypatch, _IPV6_CLIENT)

    assert resolve_client_ip(request) == _IPV6_CLIENT
    assert client_throttle_key(request) == _IPV6_CLIENT_KEY
    assert resolve_client_ip(request) != client_throttle_key(request)


def test_configured_prefix_length_widens_the_bucket(monkeypatch: pytest.MonkeyPatch) -> None:
    """Operators whose upstream delegates wider than a /64 can say so in config.

    At /56 the two addresses that differ only inside that prefix merge, while an
    address outside it keeps its own budget.
    """
    monkeypatch.setenv(IPV6_THROTTLE_PREFIX_ENV_VAR, _WIDER_PREFIX_LEN)

    inside = client_throttle_key(_proxied(monkeypatch, _IPV6_CLIENT))
    also_inside = client_throttle_key(_proxied(monkeypatch, _IPV6_SAME_SLASH_56))
    outside = client_throttle_key(_proxied(monkeypatch, _IPV6_OUTSIDE_SLASH_56))

    assert inside == _IPV6_WIDE_KEY
    assert also_inside == _IPV6_WIDE_KEY
    assert outside == _IPV6_OUTSIDE_WIDE_KEY


def test_unset_prefix_length_uses_the_documented_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """With no configuration the key is a /64, the prefix size subscribers are delegated."""
    monkeypatch.delenv(IPV6_THROTTLE_PREFIX_ENV_VAR, raising=False)

    key = client_throttle_key(_proxied(monkeypatch, _IPV6_CLIENT))

    assert key == _IPV6_CLIENT_KEY
    assert key.endswith(f"{_CIDR_MARKER}{DEFAULT_IPV6_THROTTLE_PREFIX_LEN}")


@pytest.mark.parametrize("configured", _INVALID_PREFIX_LENGTHS)
def test_unusable_prefix_length_falls_back_to_the_default(
    monkeypatch: pytest.MonkeyPatch,
    configured: str,
) -> None:
    """A config typo must degrade to the known-good default rather than be clamped.

    Clamping ``0`` up to ``1`` would still merge half the IPv6 internet into one
    bucket, and clamping ``129`` down would silently disable the grouping; only
    the default is a value an operator would have chosen on purpose.
    """
    monkeypatch.setenv(IPV6_THROTTLE_PREFIX_ENV_VAR, configured)

    key = client_throttle_key(_proxied(monkeypatch, _IPV6_CLIENT))

    assert key == _IPV6_CLIENT_KEY


@asynccontextmanager
async def _peer_client(
    db_session: AsyncSession,
    peer: tuple[str, int],
) -> AsyncIterator[AsyncClient]:
    """Yield a client whose ASGI socket peer is ``peer``, still bound to the test DB."""

    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = _override_get_session
    transport = ASGITransport(app=app, client=peer)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
    finally:
        app.dependency_overrides.pop(get_session, None)


def _arm_invalid_license_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    """Point the license allowlist at one product whose verifier never matches."""

    async def _verify_never_matches(*_args: object, **_kwargs: object) -> None:
        return None

    monkeypatch.setenv(_PRODUCT_IDS_ENV_VAR, _ALLOWLISTED_PRODUCT)
    monkeypatch.setattr(_VERIFY_SEAM, _verify_never_matches)


def _rotating_ipv6(index: int) -> str:
    """Return attempt ``index`` presented from a fresh address in the client's own /64."""
    return f"2001:db8:1:1::{index + 1:x}"


async def _attempt_signup(client: AsyncClient, forwarded: str, email: str) -> Response:
    """Send one signup whose license can never verify."""
    return await client.post(
        _SIGNUP_PATH,
        json={"email": email, "password": _SIGNUP_PASSWORD, "license_key": _LICENSE_KEY},
        headers={"X-Forwarded-For": forwarded},
    )


async def _request_reset(client: AsyncClient, forwarded: str) -> Response:
    """Send one password-reset request for an unregistered email."""
    return await client.post(
        _RESET_PATH,
        json={"email": _UNREGISTERED_EMAIL},
        headers={"X-Forwarded-For": forwarded},
    )


async def _exhaust_license_budget(client: AsyncClient) -> Response:
    """Spend the whole hourly license budget of one /64 and return the next attempt."""
    for attempt in range(INVALID_LICENSE_MAX_PER_HOUR):
        rejected = await _attempt_signup(
            client, _rotating_ipv6(attempt), f"rotate-{attempt}@example.com"
        )
        assert rejected.status_code == HTTPStatus.BAD_REQUEST
        assert rejected.json()["detail"] == _DETAIL_INVALID_LICENSE
    return await _attempt_signup(
        client,
        _rotating_ipv6(INVALID_LICENSE_MAX_PER_HOUR),
        "rotate-final@example.com",
    )


@pytest.mark.asyncio
@pytest.mark.real_license_gate
@pytest.mark.usefixtures("disable_rate_limit")
async def test_rotating_inside_one_prefix_cannot_outrun_the_license_cap(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A subscriber presenting a new address per attempt must still hit the hourly cap.

    This is the bypass itself: every request comes from the same delegated /64,
    which is one customer, so the cap has to bind on the prefix.  Keying on the
    full address gives that customer 2**64 buckets and the cap never trips.
    """
    _arm_invalid_license_gate(monkeypatch)
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _PROXY_PEER)

    async with _peer_client(db_session, (_PROXY_PEER, _PEER_PORT)) as client:
        capped = await _exhaust_license_budget(client)

    assert capped.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert capped.json()["detail"] == _DETAIL_THROTTLED


@pytest.mark.asyncio
@pytest.mark.real_license_gate
@pytest.mark.usefixtures("disable_rate_limit")
async def test_exhausting_one_prefix_leaves_a_neighbouring_prefix_untouched(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Prefix grouping must stop at the prefix boundary, not punish the next subscriber.

    Without this the cure is worse than the bug: one abusive customer would lock
    out everyone their upstream happens to number nearby.
    """
    _arm_invalid_license_gate(monkeypatch)
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _PROXY_PEER)

    async with _peer_client(db_session, (_PROXY_PEER, _PEER_PORT)) as client:
        capped = await _exhaust_license_budget(client)
        neighbour = await _attempt_signup(client, _IPV6_OTHER_CLIENT, "neighbour@example.com")

    assert neighbour.status_code == HTTPStatus.BAD_REQUEST
    assert neighbour.json()["detail"] == _DETAIL_INVALID_LICENSE
    assert capped.status_code == HTTPStatus.TOO_MANY_REQUESTS


@pytest.mark.asyncio
async def test_per_route_limiter_buckets_by_prefix_not_by_address(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The slowapi limiter shares the throttle key, so address rotation cannot refill it.

    The license cap is only one of two throttles a rotating client can outrun;
    this covers the per-route limiter, which the rate limiter must therefore be
    left enabled for.
    """
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _PROXY_PEER)

    async with _peer_client(db_session, (_PROXY_PEER, _PEER_PORT)) as client:
        for attempt in range(_RESET_REQUESTS_PER_HOUR):
            allowed = await _request_reset(client, _rotating_ipv6(attempt))
            assert allowed.status_code == HTTPStatus.ACCEPTED
        capped = await _request_reset(client, _rotating_ipv6(_RESET_REQUESTS_PER_HOUR))
        neighbour = await _request_reset(client, _IPV6_OTHER_CLIENT)

    assert capped.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert neighbour.status_code == HTTPStatus.ACCEPTED
