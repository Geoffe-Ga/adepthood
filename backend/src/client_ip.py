"""Resolve the address of the real client, for throttle keys and audit rows.

``X-Forwarded-For`` is written by whoever is talking to us, so honouring it
unconditionally hands a brute-forcer a fresh throttle bucket per request and
lets anyone attribute an audited action to an address they do not own.  The
header is therefore evidence only when the socket peer is itself a proxy the
operator declared in ``TRUSTED_PROXY_CIDRS``, and even then the chain is read
from the right, because a client can prepend entries that the proxy appends
to.  Unset or blank config trusts nobody: the header is ignored everywhere and
every control keys on the socket peer.  The same trust walk also decides
whether ``X-Forwarded-Proto`` is believed, through
:func:`peer_is_trusted_proxy`.

One trust walk, two answers.  ``resolve_client_ip`` says *who was this,
exactly* and belongs in audit rows and logs, where forensic precision is the
whole point.  ``client_throttle_key`` says *whose budget does this spend* and
belongs in every limiter, where the unit has to be a customer rather than an
address: a residential IPv6 subscriber is delegated an entire /64, so keying a
throttle on the full address hands one subscriber 2**64 buckets and no cap can
ever trip.  IPv4 has no such gift -- one client, one address -- so it is keyed
on the address unchanged; grouping it by prefix would make unrelated customers
behind one carrier NAT throttle each other.  Both projections read the same
resolved address object so they can never drift apart on trust.

Deliberately a leaf module -- it imports nothing of ours.  :mod:`rate_limit`
and ``routers.auth`` both need this answer, and ``rate_limit_keys`` documents
the import cycle between those two that a dependency-free module avoids.
"""

from __future__ import annotations

import ipaddress
import os

from fastapi import Request
from starlette.requests import HTTPConnection

# Comma-separated IPs and/or CIDR blocks naming the proxies we operate.
TRUSTED_PROXIES_ENV_VAR = "TRUSTED_PROXY_CIDRS"

# How much of an IPv6 address identifies the subscriber rather than the host
# they picked this second.  Configurable because an upstream that delegates
# wider than a /64 needs a wider bucket to hold one customer.
IPV6_THROTTLE_PREFIX_ENV_VAR = "IPV6_THROTTLE_PREFIX_LEN"

# The size residential upstreams are expected to delegate, and the fallback for
# any configured value we cannot use.
DEFAULT_IPV6_THROTTLE_PREFIX_LEN = 64

# A prefix length is a bit count, so anything below one bit is not a prefix and
# nothing wider than the address itself is one either.  Both are public because
# the boot-time config check quotes this range back to the operator, and a range
# stated in two places is a range that eventually disagrees with itself.
MIN_IPV6_THROTTLE_PREFIX_LEN = 1
MAX_IPV6_THROTTLE_PREFIX_LEN = ipaddress.IPV6LENGTH

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


def _parse_prefix_length(raw: str) -> int | None:
    """Parse one config value as a bit count, or None when it is not one."""
    try:
        return int(raw)
    except ValueError:
        return None


def _usable_prefix_length(raw: str) -> int | None:
    """Return the prefix ``raw`` asks for, or None when it does not name one.

    The single judgement of what counts as a prefix, so the runtime and the
    boot-time check below cannot come to different conclusions about the same
    string: whatever the runtime would discard is exactly what boot announces.
    ``int`` tolerates surrounding whitespace, so a padded value is configuration
    rather than a typo, and a blank value names no prefix at all.
    """
    configured = _parse_prefix_length(raw)
    if configured is None:
        return None
    if not (MIN_IPV6_THROTTLE_PREFIX_LEN <= configured <= MAX_IPV6_THROTTLE_PREFIX_LEN):
        return None
    return configured


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


def _throttle_prefix_length() -> int:
    """Read the IPv6 throttle prefix length from the environment at call time.

    Reading per call means retuning the bucket needs no restart, exactly as for
    the proxy allowlist.  Anything that is not a usable prefix degrades to the
    default rather than being clamped into range: ``0`` would collapse every
    IPv6 client on earth into one bucket -- a self-inflicted denial of service
    on all legitimate IPv6 users -- and clamping ``129`` down would silently
    disable the grouping altogether.  The default is the only value an operator
    would have chosen deliberately, so it is the only safe reading of a typo.

    The range check asks only whether a value is a prefix, not whether it is a
    wise one.  ``IPV6LENGTH`` itself is the deliberate opt-out -- it restores
    exact per-address keying, and with it the rotation this module groups
    against -- and a very small value groups very coarsely on purpose.  Both are
    an operator's call to make; only a value that is not a prefix at all is
    a typo this can recognise as such.

    Deliberately silent about that fallback.  This runs on every IPv6 request,
    so logging here would turn one typo into a log flood at request rate; the
    announcement belongs to boot, via :func:`unusable_throttle_prefix_config`.
    """
    configured = _usable_prefix_length(os.getenv(IPV6_THROTTLE_PREFIX_ENV_VAR, ""))
    return DEFAULT_IPV6_THROTTLE_PREFIX_LEN if configured is None else configured


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


def _socket_peer(connection: HTTPConnection) -> _Address | None:
    """Return the peer that opened the connection, or None when there is none to key on.

    Typed on :class:`HTTPConnection` rather than :class:`Request` because only
    ``.client`` is read, and the scheme decision below runs before a request
    body exists.  ``Request`` is a subclass, so every caller here is unaffected.
    """
    peer = connection.client
    return None if peer is None else _client_address(peer.host)


def _throttle_key(address: _Address) -> str:
    """Return the budget ``address`` spends from: its prefix if IPv6, itself if IPv4.

    CIDR text is the form on purpose.  ``ipaddress`` compresses a network
    canonically, so the two limiter backends -- which compare keys for byte
    equality -- cannot mint a duplicate bucket for one prefix, and the key
    states the prefix it was cut at, so retuning the config visibly re-buckets
    rather than quietly reusing stale counters.  The key namespaces stay
    disjoint by construction: IPv4 keys are dotted quads carrying neither ``:``
    nor ``/``, IPv6 prefix keys always carry ``/``, the unknown-client answer
    carries neither, and authenticated keys carry a ``user:`` prefix.

    That ``/`` is also the separator ``limits`` joins its composite bucket key
    with, so it is worth saying why introducing one here is safe: a collision
    would need a key that is a strict prefix of another ending exactly at a
    separator, i.e. a bare IPv6 address with no ``/N`` suffix, and no branch
    below can emit one.

    ``_unmapped`` has already folded ``::ffff:203.0.113.5`` into an IPv4
    address, so a mapped literal takes the IPv4 arm for free -- prefixing it
    would group the whole mapped range, i.e. the entire IPv4 internet, into a
    single bucket.
    """
    if not isinstance(address, ipaddress.IPv6Address):
        return str(address)
    prefixed = f"{address}/{_throttle_prefix_length()}"
    return str(ipaddress.ip_network(prefixed, strict=False))


def _resolved_client(request: Request) -> _Address | None:
    """Return the address to charge this request to, or None when there is none.

    Falls back to the socket peer whenever the forwarded chain cannot be
    trusted or cannot be believed -- an unvouched peer, a missing header, a
    chain of nothing but our own proxies, or a chosen hop that is not an IP
    literal.  A peer that is not an IP literal itself yields None, so a junk or
    over-wide value can reach neither a rate-limit key nor an audit column.

    The single shared resolution behind both projections below: one trust walk,
    one canonicalisation of mapped literals, one rejection of zone ids, so what
    a throttle charges and what an audit row records can never drift apart.
    """
    peer = _socket_peer(request)
    if peer is None:
        return None
    networks = _trusted_networks()
    if not _is_trusted(peer, networks):
        return peer
    hop = _client_hop(_forwarded_hops(request), networks)
    return peer if hop is None else hop


def resolve_client_ip(request: Request) -> str:
    """Return exactly who made this request, for audit rows and logs.

    The forensic projection: the full address, never widened, because an audit
    trail that names a /64 names a few billion hosts and identifies nobody.
    Throttles must not use this -- see :func:`client_throttle_key`.
    """
    address = _resolved_client(request)
    return _UNKNOWN_CLIENT if address is None else str(address)


def client_throttle_key(request: Request) -> str:
    """Return whose budget this request spends, for every rate limiter.

    The throttle projection: the same resolved client as
    :func:`resolve_client_ip`, but grouped onto the prefix its subscriber was
    delegated when it is IPv6, so rotating through that delegation cannot buy a
    fresh bucket per request.
    """
    address = _resolved_client(request)
    return _UNKNOWN_CLIENT if address is None else _throttle_key(address)


def peer_is_trusted_proxy(connection: HTTPConnection) -> bool:
    """Report whether the socket peer is one of the proxies the operator declared.

    The trust projection: exactly the decision :func:`_resolved_client` takes
    before it will read ``X-Forwarded-For``, exposed so that whoever is allowed
    to report the scheme and whoever is allowed to report the client address are
    settled against one allowlist and one parser.  Two trust walks could
    disagree; one cannot.

    Because it goes through ``_socket_peer`` it inherits that resolution
    wholesale -- the IPv4-mapped folding that lets a plain IPv4 config entry
    still name a proxy a dual-stack listener reports as ``::ffff:...``, and the
    rejection of scoped IPv6 literals -- rather than re-deciding any of it here.
    """
    peer = _socket_peer(connection)
    return peer is not None and _is_trusted(peer, _trusted_networks())


def unusable_throttle_prefix_config() -> str | None:
    """Return the configured prefix value the runtime cannot use, else None.

    Exists so a caller that *can* log -- boot, once -- can say what the silent
    per-request fallback in :func:`_throttle_prefix_length` swallowed.  This
    module stays a leaf and stays quiet: it reports the finding and lets its
    caller decide what to do about it.

    Unset and blank both answer None.  ``backend/.env.example`` ships the
    variable present but empty, so treating blank as a mistake would fire the
    warning on every stock boot and teach operators to ignore it.  The value
    comes back verbatim rather than stripped, because the operator has to
    recognise what they typed -- a stray space is the whole bug.
    """
    raw = os.getenv(IPV6_THROTTLE_PREFIX_ENV_VAR)
    if raw is None or not raw.strip():
        return None
    if _usable_prefix_length(raw) is not None:
        return None
    return raw
