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

# Answer for a request whose ASGI scope carries no socket peer at all.
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


def _is_trusted(host: str, networks: list[_Network]) -> bool:
    """Return True when ``host`` is an address inside one of our proxy networks."""
    address = _parse_address(host)
    return address is not None and any(address in network for network in networks)


def _forwarded_hops(request: Request) -> list[str]:
    """Return the forwarded chain as hops, ordered client-first as the RFC has it."""
    return _split_entries(request.headers.get(_FORWARDED_FOR_HEADER, ""))


def _client_hop(hops: list[str], networks: list[_Network]) -> str | None:
    """Pick the hop that belongs to the client from a chain we know is vouched.

    Walking from the right skips the proxies we operate and stops at the first
    address one of them observed, so entries the client prepended sit further
    left and can never win.  When every hop is one of ours the left-most is the
    closest thing to a client the chain records.
    """
    for hop in reversed(hops):
        if not _is_trusted(hop, networks):
            return hop
    return hops[0] if hops else None


def resolve_client_ip(request: Request) -> str:
    """Return the address to charge this request to: throttles and audit agree on it.

    Falls back to the socket peer whenever the forwarded chain cannot be
    trusted or cannot be believed -- an unvouched peer, a missing header, or a
    chosen hop that is not an IP literal.  That keeps junk and forgeries out of
    both rate-limit keys and audit rows.
    """
    peer = request.client
    if peer is None:
        # A request with no socket peer cannot be one of our proxies.
        return _UNKNOWN_CLIENT
    networks = _trusted_networks()
    if not _is_trusted(peer.host, networks):
        return peer.host
    hop = _client_hop(_forwarded_hops(request), networks)
    if hop is None or _parse_address(hop) is None:
        return peer.host
    return hop
