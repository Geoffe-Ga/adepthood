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
from typing import TYPE_CHECKING

from services.creek_vault_url_user import (
    UserVaultUrlDefect,
    UserVaultUrlFinding,
    address_is_blocked,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

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

# How long one lookup may take before it is abandoned. Five seconds: longer than
# any healthy resolver needs for a cached record and for most uncached ones, and
# short enough that a request waiting on it is still recognisably a request.
#
# The bound matters because of what is *rented* for the duration rather than
# because of the wait itself. This runs behind a per-request dependency, so the
# caller is holding one of the engine's fifteen pooled connections while it
# waits; without a number chosen here, that hold lasts as long as the operating
# system's own resolver budget -- ``timeout`` times ``attempts`` times the
# number of nameservers in ``resolv.conf``, tens of seconds on an ordinary box.
# That was never infinity. It was a number written in a file this deployment
# does not own, cannot read from here, and which differs between the container
# this runs in and the laptop it was written on.
#
# Bounded here rather than at either call site so that a caller written later
# inherits the bound instead of having to remember it. Nesting is safe: an
# ``asyncio.timeout`` converts a cancellation to ``TimeoutError`` only when its
# own deadline is the one that expired, so this cannot swallow an outer budget
# such as the vault pipeline's per-stage one.
LOOKUP_BUDGET_SECONDS = 5.0

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

    :data:`LOOKUP_BUDGET_SECONDS` bounds the wait, and the bound lives here so
    that every caller gets it. Abandoning the wait raises the builtin
    ``TimeoutError``, which every caller of this function already treats as a
    lookup that did not answer -- fail-closed in both, since an unestablished
    destination is an unchecked one.

    Freeing the waiter is not the same as stopping the lookup. ``getaddrinfo``
    is a blocking call running in asyncio's default thread pool, this process
    installs neither ``aiodns`` nor an executor of its own, and there is no way
    to interrupt a thread parked inside the C resolver. So the deadline returns
    the *coroutine*, and with it the database connection the caller was holding;
    the thread stays occupied until the platform gives up on its own. That is the
    half of the exposure a timeout cannot close, and the cached verdict above is
    what keeps a repeated dead host from parking a thread per request.
    """
    loop = asyncio.get_running_loop()
    async with asyncio.timeout(LOOKUP_BUDGET_SECONDS):
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

    A lookup abandoned on :data:`LOOKUP_BUDGET_SECONDS` lands here too, and by
    the same reasoning: the builtin ``TimeoutError`` is an ``OSError``, so the
    set above already carries it. It is not listed separately -- a redundant
    handler is one the linter would reject and one a reader would have to check
    -- but it is not left to be discovered either. That a timeout answers as
    ``unresolvable_host`` is a contract a client renders, so it is pinned by name
    in ``test_ssrf_vault_url.py`` rather than inherited quietly from the
    standard library's class hierarchy.

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


async def classify_resolved_user_vault_url_off_the_pool(
    session: AsyncSession, host: str
) -> UserVaultUrlFinding | None:
    """Ask the question above without holding a database connection while it is answered.

    The only spelling of this question available outside this module, and that is
    the point of it rather than a convenience. Both callers reach the lookup with
    a transaction already open -- the write path through an authentication
    dependency it never mentions, the dial path through the row it read on the
    line above -- and neither author had to do anything wrong to get there.

    **What an open transaction costs.** A ``Session`` autobegins on its first
    ``execute`` and holds the connection it checked out there across every later
    ``await``. The engine runs on SQLAlchemy's defaults: five connections plus
    ten of overflow, with a thirty-second wait for a checkout. So fifteen
    requests waiting on a slow resolver hold the whole pool for the length of a
    lookup, and the sixteenth request to *any* database-backed endpoint --
    somebody else's journal save, somebody else's login -- blocks on checkout and
    fails. The lookup is bounded now, which makes that hold finite; ending the
    transaction first is what stops it happening at all.

    **Why commit and not rollback.** Everything above this call on both paths is
    a read, so there is nothing to make durable and ``rollback`` is arguably the
    more honest word for what is happening. It is not the safer one. This runs
    inside a per-request dependency on a session the caller owns, and under the
    test suite that session is the test's own; a ``rollback`` from here would
    discard whatever the caller had staged and not yet committed, and a
    ``commit`` cannot. It is also the word the two sites that already protect
    this invariant use, and one invariant with two idioms is how the next
    instance gets written.

    **Committed unconditionally**, including when the classifier turns out to
    answer from its cache or from the string alone. Deciding first would mean
    re-asking the two questions the classifier asks anyway, and getting a stale
    answer to either of them would put the lookup back under an open transaction
    on exactly the request where the cache had just expired. The statement is
    also not really spurious: the dependency is finished with the database at
    this point either way, and releasing early is right regardless of what
    happens next.

    **What this does not do.** It frees the connection, not the resolver. Nothing
    here shortens the lookup or protects the thread it runs on; the bound above
    does the first and nothing in this process can do the second.
    """
    await session.commit()
    return await classify_resolved_user_vault_url(host)
