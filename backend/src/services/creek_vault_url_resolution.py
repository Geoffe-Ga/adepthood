"""Where a user-supplied vault host actually points, and what that costs to ask.

The resolving half of the request-forgery guard, and the only half that touches
the network. :mod:`services.creek_vault_url_user` decides everything decidable
from a string; this module answers the one question left -- what does this name
resolve to -- and hands the answer straight back to those same rules, so a name
and a literal are judged against one set of criteria rather than two.

**Fail closed.** A host that does not resolve is refused, and the kindness of
accepting it is the whole bypass: a name that answers NXDOMAIN at write time can
be made to answer ``10.0.0.7`` by whoever controls the zone, and by then the URL
is stored and being dialled with the user's credential attached. A resolver that
is merely unreachable is refused for the same reason and is deliberately
indistinguishable -- both mean nobody has checked this destination.

**Every answer must pass.** A name resolving to one public address and one
private one is a name that reaches the private one, since which record a
connection uses is not ours to choose. So the verdict is the strictest of them,
across A and AAAA alike.

**Both verdicts are cached, briefly.** This runs on the write path and on every
journal save behind a per-request dependency, so an uncached lookup would put a
DNS round trip on a writer's latency budget. The window is short on purpose: it
is a rebinding guard, and a long cache would be one more place for the answer to
go stale in the attacker's favour. Caching the *approving* verdict matters as
much as caching the refusing one, since the approving path is the common one.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
import time

from services.creek_vault_url_user import (
    UserVaultUrlDefect,
    UserVaultUrlFinding,
    address_is_blocked,
)

# How long one host's verdict stands before it is asked again. A minute: long
# enough that a burst of journal saves costs one lookup, short enough that a
# rebinding attacker gains nothing worth having by waiting out the window.
_RESOLUTION_TTL_SECONDS = 60.0

# How many distinct hosts may hold a verdict at once. Expiry alone does not
# bound this map: every entry inside one window is live, and the names are
# chosen by whoever is sending requests, so a burst of distinct hosts would
# grow it by one entry each until the window turned over. The ceiling is what
# makes that a bounded cost rather than a memory-exhaustion lever, and it is
# high enough that no honest deployment -- one vault per account -- approaches
# it. Overflow drops every verdict rather than the oldest: a cleared map costs
# a lookup that was going to be made anyway, and choosing a victim would mean
# tracking an access order this module has no other reason to keep.
MAX_CACHED_HOSTS = 1024

# Where the address lives in one ``getaddrinfo`` answer. The answer is a
# five-tuple ending in the sockaddr, and the sockaddr's first member is the
# textual address for both families -- IPv6 adds flowinfo and scope id after it,
# neither of which names a different destination. Named rather than written as a
# bare subscript, because ``sockaddr[0]`` is the kind of thing a reader has to go
# and look up.
_ADDRESS_INDEX = 0

# What a refusal says, in this module's own words and never in the caller's. The
# host is deliberately absent: this string reaches a log line and a 422 body, and
# the value it would quote came out of a request body next to a credential.
_UNRESOLVABLE_DETAIL = "the URL names a host whose destination could not be established"
_RESOLVED_PRIVATE_DETAIL = "the URL names a host that resolves outside the public internet"

_UNRESOLVABLE_FINDING = UserVaultUrlFinding(
    UserVaultUrlDefect.UNRESOLVABLE_HOST, _UNRESOLVABLE_DETAIL
)
_RESOLVED_PRIVATE_FINDING = UserVaultUrlFinding(
    UserVaultUrlDefect.PRIVATE_ADDRESS, _RESOLVED_PRIVATE_DETAIL
)

# One host's verdict and the monotonic instant it stops standing. Monotonic
# rather than wall-clock so a clock correction cannot extend an entry's life.
_resolution_cache: dict[str, tuple[UserVaultUrlFinding | None, float]] = {}


def reset_resolution_cache() -> None:
    """Forget every cached verdict.

    Exists for tests, which repoint the lookup between cases: an entry outlives
    a test by a minute of wall-clock time, which is longer than a suite takes, so
    a leaked answer is a real ordering dependency rather than a theoretical one.
    """
    _resolution_cache.clear()


def cached_host_count() -> int:
    """Report how many verdicts are currently held.

    The ceiling on this map is a security property rather than a tuning knob, so
    it is something a test has to be able to assert on. Reaching into the map
    itself from a test would couple the assertion to the shape of a private,
    and the shape is the part most likely to change; the count is the part that
    must not.
    """
    return len(_resolution_cache)


async def resolve_host_addresses(host: str) -> tuple[str, ...]:
    """Return every textual address ``host`` resolves to, raising if it resolves to none.

    Public, and the single implementation both halves of the guard share: the
    cached verdict this module computes on the write and dial paths, and the
    uncached connect-time pin in
    :mod:`services.creek_vault_pinned_transport`. Two lookups written twice would
    be two chances to disagree about what a name points at, which is the whole
    subject of this guard.

    A module-level function rather than a method or an injected collaborator
    because it is the seam the whole guard is tested through: a test that
    consulted the real resolver would be asserting something about the network
    the suite happens to be running on, and could not express a rebinding case at
    all.

    ``loop.getaddrinfo`` rather than the blocking call it wraps. The synchronous
    one holds the event loop for the duration of a DNS round trip, which on this
    path means every other request in the process waits on one writer's vault.

    ``SOCK_STREAM`` is asked for, and the answer is deduplicated, because the
    same address arriving twice is not free. With no socktype hint the resolver
    answers once per socktype -- two rows an address here, three under glibc --
    and the connect-time pin walks its answers in order, so a duplicate spends a
    whole connect budget re-dialling the address that has just failed. Against a
    family that blackholes rather than refusing, that is enough to exhaust the
    walk inside the whole-request deadline before it ever crosses to the other
    family, which is the one thing the walk exists to do. The hint alone would
    settle it on this platform; the dedup is what makes the property true of the
    function rather than of the machine it runs on. A stream socket is also the
    only kind this answer is ever used to open.
    """
    loop = asyncio.get_running_loop()
    answers = await loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    return tuple(dict.fromkeys(str(sockaddr[_ADDRESS_INDEX]) for *_, sockaddr in answers))


def host_is_address_literal(host: str) -> bool:
    """Report whether ``host`` is already an address and so owes no lookup.

    Public for the same reason its neighbour above is: it is the single
    implementation both halves of the guard share, the cached verdict here and
    the uncached connect-time pin in
    :mod:`services.creek_vault_pinned_transport`. A second spelling of "this is
    already an address" is a second place for the two to disagree about which
    hosts get looked up at all.
    """
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def _fresh_verdict(host: str) -> tuple[UserVaultUrlFinding | None, float] | None:
    """Return this host's cached entry while it still stands, else ``None``.

    The entry is returned whole rather than just its verdict, because the verdict
    itself is legitimately ``None`` -- "nothing wrong with this host" is the
    answer worth caching most -- and a bare ``None`` return could not tell that
    apart from a miss.
    """
    entry = _resolution_cache.get(host)
    if entry is None or entry[1] <= time.monotonic():
        return None
    return entry


def _remember(host: str, finding: UserVaultUrlFinding | None) -> None:
    """Cache ``host``'s verdict for the window, under a ceiling on how many stand.

    Two different limits, because they bound two different things and either
    alone leaves the other open. The sweep bounds *staleness*: an expired
    verdict is dropped rather than answered from. The ceiling bounds *count*,
    which the sweep cannot -- entries inside one window have not expired, and
    the hosts are chosen by whoever is sending requests, so a burst of distinct
    names would grow the map unchecked until the window turned over. Without
    the ceiling this would be a memory-exhaustion lever handed to the same
    person the rest of this module exists to refuse.
    """
    now = time.monotonic()
    for stale in [name for name, entry in _resolution_cache.items() if entry[1] <= now]:
        del _resolution_cache[stale]
    if len(_resolution_cache) >= MAX_CACHED_HOSTS:
        _resolution_cache.clear()
    _resolution_cache[host] = (finding, now + _RESOLUTION_TTL_SECONDS)


async def _judge(host: str) -> UserVaultUrlFinding | None:
    """Look ``host`` up and report the strictest thing true of what came back.

    The degrade set is wider than the one failure worth naming. ``socket.gaierror``
    is NXDOMAIN and an unreachable resolver both, which is the case that matters
    and the case the guard must not be able to tell apart. Its base ``OSError``
    and ``UnicodeError`` are here because ``getaddrinfo`` raises them too -- a
    label past the DNS length limit, a name IDNA cannot encode, a socket layer
    refusing for a reason of its own -- and this function is on a per-request
    dependency's path, where an exception escaping costs the writer the entry
    they were saving. Every one of them means the same thing anyway: nobody
    established where this host points, and an unestablished destination is an
    unchecked one.

    Nothing is bound. A resolver's exception message quotes the name it failed
    on, which came out of a request body, and this seam's records never repeat a
    submitted value.
    """
    try:
        addresses = await resolve_host_addresses(host)
    except (OSError, UnicodeError):
        return _UNRESOLVABLE_FINDING
    if not addresses:
        return _UNRESOLVABLE_FINDING
    if any(address_is_blocked(address) for address in addresses):
        return _RESOLVED_PRIVATE_FINDING
    return None


async def classify_resolved_user_vault_url(host: str) -> UserVaultUrlFinding | None:
    """Name what makes ``host`` undialable once resolved, or ``None`` if nothing does.

    The half of the guard that costs something, so it is asked only when it can
    answer anything. A literal address was already judged on sight by
    :func:`~services.creek_vault_url_user.classify_user_vault_url_host` and
    resolving it would be a lookup that can only return the address it was given.
    A URL that names no host at all reaches here from the dial-time path, where
    the shared classifier has not run; it is refused rather than looked up,
    because ``getaddrinfo("")`` answers with this machine's own loopback and a
    guard that dialled it would have found the hole by walking into it.
    """
    if host_is_address_literal(host):
        return None
    if not host:
        return _UNRESOLVABLE_FINDING
    entry = _fresh_verdict(host)
    if entry is not None:
        return entry[0]
    finding = await _judge(host)
    _remember(host, finding)
    return finding
