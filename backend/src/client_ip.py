"""Resolve the address of the real client, for throttle keys and audit rows.

``X-Forwarded-For`` is written by whoever is talking to us, so honouring it
unconditionally hands a brute-forcer a fresh throttle bucket per request and
lets anyone attribute an audited action to an address they do not own.  The
header is therefore evidence only when the socket peer is itself a proxy the
operator declared in ``TRUSTED_PROXY_CIDRS``, and even then the chain is read
from the right, because a client can prepend entries that the proxy appends
to.  Unset or blank config trusts nobody: the header is ignored everywhere and
every control keys on the socket peer.

Deliberately a leaf module -- it imports nothing of ours.  :mod:`rate_limit`
and ``routers.auth`` both need this answer, and ``rate_limit_keys`` documents
the import cycle between those two that a dependency-free module avoids.
"""

from __future__ import annotations

import ipaddress
import os

from fastapi import Request

# Comma-separated IPs and/or CIDR blocks naming the proxies we operate.
TRUSTED_PROXIES_ENV_VAR = "TRUSTED_PROXY_CIDRS"

# Both the config variable and the forwarded header are comma-separated lists.
_ENTRY_SEPARATOR = ","
_FORWARDED_FOR_HEADER = "x-forwarded-for"

# Answer for a request whose socket peer is absent or is not an IP literal.
_UNKNOWN_CLIENT = "unknown"

_Network = ipaddress.IPv4Network | ipaddress.IPv6Network
_Address = ipaddress.IPv4Address | ipaddress.IPv6Address


def _parse_network(entry: str) -> _Network | None:
    """Parse one config entry as a network, or None when it is unparseable.

    ``strict=False`` lets a bare address arrive as a single-host network, so
    operators can list individual proxies and CIDR blocks interchangeably.
    """
    try:
        return ipaddress.ip_network(entry, strict=False)
    except ValueError:
        return None


def _parse_address(value: str) -> _Address | None:
    """Parse ``value`` as an IP literal, or None when it is not one."""
    try:
        return ipaddress.ip_address(value)
    except ValueError:
        return None


def _is_scoped(address: _Address) -> bool:
    """Report whether an IPv6 literal carries a zone id such as ``fe80::1%eth0``."""
    return isinstance(address, ipaddress.IPv6Address) and address.scope_id is not None


def _unmapped(address: _Address) -> _Address:
    """Return the IPv4 address behind an IPv4-mapped IPv6 literal, else ``address``.

    ``::ffff:198.51.100.7`` and ``198.51.100.7`` are one host, so they must
    produce one throttle bucket and one audited address rather than two.
    """
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def _client_address(value: str) -> _Address | None:
    """Return the canonical address to key on for ``value``, or None when there is none.

    A zone id names an interface on one machine, so it cannot identify a client
    seen across a proxy hop -- and ``ipaddress`` accepts a zone id of any
    length, which would let a hop parse cleanly and still overflow the audit
    column that stores the result.  Rejecting scoped literals keeps every
    answer a bounded, comparable address.
    """
    address = _parse_address(value)
    if address is None or _is_scoped(address):
        return None
    return _unmapped(address)


def _split_entries(raw: str) -> list[str]:
    """Split one comma-separated value into stripped, non-blank entries.

    Shared by the config and the header so the two cannot diverge on tolerance:
    padding, empty entries, and a trailing separator are harmless on both sides,
    and an empty value yields no entries rather than one blank one.
    """
    return [entry.strip() for entry in raw.split(_ENTRY_SEPARATOR) if entry.strip()]


def _trusted_networks() -> list[_Network]:
    """Read the trusted-proxy allowlist from the environment at call time.

    Reading per call means rotating the proxy set needs no restart.  An entry
    that does not parse is dropped rather than defaulted -- dropping narrows
    trust, which is the safe direction to fail.
    """
    entries = _split_entries(os.getenv(TRUSTED_PROXIES_ENV_VAR, ""))
    parsed = (_parse_network(entry) for entry in entries)
    return [network for network in parsed if network is not None]


def _is_trusted(address: _Address, networks: list[_Network]) -> bool:
    """Return True when ``address`` sits inside one of our proxy networks."""
    return any(address in network for network in networks)


def _forwarded_hops(request: Request) -> list[str]:
    """Return the forwarded chain as hops, ordered client-first as the RFC has it.

    Every ``X-Forwarded-For`` field line counts.  HAProxy's ``option
    forwardfor`` appends a second line rather than extending the first, so
    reading only the first line would hand a client that sent its own header
    authorship of the whole chain; joining the lines keeps the proxy-authored
    hop where it belongs, at the far right.
    """
    lines = request.headers.getlist(_FORWARDED_FOR_HEADER)
    return _split_entries(_ENTRY_SEPARATOR.join(lines))


def _client_hop(hops: list[str], networks: list[_Network]) -> _Address | None:
    """Pick the hop that belongs to the client from a chain we know is vouched.

    Walking from the right skips the proxies we operate and stops at the first
    address one of them observed, so entries the client prepended sit further
    left and can never win.  A chain that names nobody outside our own proxies
    yields None: the left-most entry is exactly the one a client can author, so
    falling back to it would reinstate the forgery this module exists to stop,
    and a request whose every hop is ours originated inside our infrastructure,
    where the socket peer is already the right answer.
    """
    for hop in reversed(hops):
        address = _client_address(hop)
        if address is None:
            # The chain records something we cannot attribute to anyone.
            return None
        if not _is_trusted(address, networks):
            return address
    return None


def _socket_peer(request: Request) -> _Address | None:
    """Return the peer that opened the connection, or None when there is none to key on."""
    peer = request.client
    return None if peer is None else _client_address(peer.host)


def resolve_client_ip(request: Request) -> str:
    """Return the address to charge this request to: throttles and audit agree on it.

    Falls back to the socket peer whenever the forwarded chain cannot be
    trusted or cannot be believed -- an unvouched peer, a missing header, a
    chain of nothing but our own proxies, or a chosen hop that is not an IP
    literal.  A peer that is not an IP literal itself resolves to
    ``_UNKNOWN_CLIENT``, so a junk or over-wide value can reach neither a
    rate-limit key nor an audit column.
    """
    peer = _socket_peer(request)
    if peer is None:
        return _UNKNOWN_CLIENT
    networks = _trusted_networks()
    if not _is_trusted(peer, networks):
        return str(peer)
    hop = _client_hop(_forwarded_hops(request), networks)
    return str(peer if hop is None else hop)
