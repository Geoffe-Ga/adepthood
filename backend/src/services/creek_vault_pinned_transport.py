"""The address a user's vault was approved at is the address its socket opens to.

The rest of the request-forgery guard decides *whether* a user-supplied vault URL
may be dialled: :mod:`services.creek_vault_url_user` judges everything decidable
from the string, and :mod:`services.creek_vault_url_resolution` resolves the name
and hands every answer back to those same rules. This module is about the gap
between that decision and the dial. httpx is handed a URL that still names the
name, so httpx resolves it again when it connects, and the *second* answer is the
one the socket gets. A zone whose record flips between those two moments passes a
check against a public address and opens a connection to ``10.0.0.7``, carrying
the bearer credential its owner supplied. No rule added upstream can close that:
it is not a missing rule, it is a second lookup nobody asked for.

**So the approved address is pinned rather than merely re-checked.** Checking
again, however late, still leaves a lookup between the verdict and the connect --
it narrows the window without closing it. One lookup whose answer is written into
the URL leaves no window at all, because there is no second answer to differ.

**The original hostname travels onward, twice.** It stays in the ``Host`` header,
because the address is a transport-layer fact and the header is an
application-layer one -- rewriting it would aim a correct connection at the wrong
site on a shared host. And it is set as the TLS server name, because a
certificate verified against an address proves nothing about the vault: the point
of the handshake is that the peer is the name its owner typed.

**Any blocked answer refuses the whole destination.** Filtering down to the
surviving address is the tempting repair and it is wrong twice over. The verdict
the write path already applies is the strictest across A and AAAA alike, so a
filtering pin would be looser here than upstream; and whoever controls the zone
would then choose which record survives the filter next time. A name that points
anywhere internal is refused as a name. What survives that verdict is dialled in
resolver order rather than pinned to answer zero, which is a different thing
entirely: nothing was filtered, so every address tried had already passed the
same predicate.

**An address literal owes no lookup and is still judged.** Resolving it could
only return the address it was handed, at the price of a DNS round trip on a
writer's latency budget and of a second answer that could differ from the first.
Judging it is separate: everything reaching here has passed the write-time and
dial-time guards *in principle*, and "in principle" is what a restored backup or
a rule tightened after the row was stored breaks. The last thing before the
socket is the one place where being sure costs nothing.

**The lookup used is the uncached one**, not the sixty-second verdict cache the
write and dial paths share. That cache is exactly the staleness this module
exists to close; pinning to it would reopen the same window one layer down.

**Keep-alive is off on the pool this transport backs.** httpcore keys a pooled
connection on its origin alone and never consults the TLS server name. Once the
origin is a pinned address, two vault hostnames that happen to resolve to the
same address would share one connection -- whose certificate proved only the
first of the two names. Holding a connection open would buy a stale-DNS fix at
the price of a cross-vault one.

**Every refusal is an** :class:`httpx.ConnectError`. This transport runs inside a
per-request dependency: an exception it invents means the handler body never
executes and the writer loses the entry they were saving, to save them from a
connection they never saw. ``httpx.ConnectError`` is what the existing degrade
sets in :mod:`services.creek_vault_client` already understand, so a refusal costs
its owner the vault and never their writing. Refusing a destination is also
truthfully a connection failure: no connection was made.

The resolver is reached as an attribute of
:mod:`services.creek_vault_url_resolution` rather than imported by bound name,
and that is load-bearing rather than stylistic. The tests repoint the lookup with
``setattr`` on that module; a bound name would keep calling the real
``getaddrinfo``, answer NXDOMAIN for every fixture hostname, and refuse -- so
every refusal case in the suite would pass for a reason that has nothing to do
with what it asserts. Do not tidy this into ``from ... import``.
"""

from __future__ import annotations

import logging

import httpx

# httpx does not re-export its default limits from the package root, so the
# private module is the only place to read them. Reading them beats restating
# the number: a hand-copied ceiling is a second opinion that silently stops
# matching the pool it was supposed to match.
from httpx._config import DEFAULT_LIMITS

from services import creek_vault_url_resolution
from services.creek_vault_url_user import address_is_blocked

_LOGGER = logging.getLogger(__name__)

# What a refusal says, in this module's own words and never in the caller's. The
# host is deliberately absent: this string reaches a log line and travels on an
# exception into whatever renders a degrade, and the value it would quote arrived
# in a request body next to a bearer credential.
_REFUSED_MESSAGE = "the vault URL names a destination this server must not dial"

# The log record for the same event, static and value-free for the same reason,
# and greppable like every other record in this seam.
_REFUSED_EVENT = "a connected creek vault dial was refused: its destination is not dialable"

# Which failures move on to the next approved address, and nothing wider. A
# refused or timed-out connect means no connection was ever made, so trying
# somewhere else costs nothing and risks nothing. A read or write failure means
# the connection LANDED: the vault may already have acted on the request, and
# re-sending it to another address would be this seam deciding on its own to
# repeat a write. ``httpx.ConnectTimeout`` is named separately because it is a
# ``TimeoutException`` rather than a ``ConnectError`` subclass, so the obvious
# one-element tuple would silently cover only half the case.
_NEXT_ADDRESS_ERRORS: tuple[type[Exception], ...] = (httpx.ConnectError, httpx.ConnectTimeout)

# The ceiling on simultaneously open connections, INHERITED from httpx's own
# default rather than chosen here: the operator's pool is built with no limits at
# all and therefore gets exactly this number, and two pools carrying the same
# deployment's traffic should be bounded alike or the difference is an accident
# nobody decided on. It is spelled out because ``httpx.Limits`` defaults every
# field it is not given, so naming only ``max_keepalive_connections`` would leave
# this at ``None``, which httpcore reads as ``sys.maxsize``.
_MAX_PINNED_CONNECTIONS = DEFAULT_LIMITS.max_connections

# No connection is held open between requests. httpcore matches a pooled
# connection on origin alone and never on the TLS server name, so once the origin
# is a pinned address two vault hostnames sharing that address would share a
# connection whose certificate proved only the first of them.
#
# Dropping keep-alive is also precisely what makes an unbounded pool the danger
# worth naming: every single request then opens a fresh TCP and TLS connection,
# so without the ceiling above, concurrent journal saves have no bound on sockets
# or file descriptors and the ``pool`` slice of the vault timeout -- the one
# meant to shed load rather than exhaust the process -- can never engage, because
# there is never anything to queue behind.
PINNED_CONNECTION_LIMITS = httpx.Limits(
    max_connections=_MAX_PINNED_CONNECTIONS, max_keepalive_connections=0
)


class ForbiddenDestinationError(httpx.ConnectError):
    """Raised instead of dialling a destination this server must not reach.

    An :class:`httpx.ConnectError` subclass rather than an exception of its own
    hierarchy, because this is raised on a per-request path whose callers already
    degrade on ``httpx.HTTPError``. A novel type there would escape every degrade
    set and cost a writer the entry they were saving. It is also honest: nothing
    was connected.
    """


class PinnedDestinationTransport(httpx.AsyncBaseTransport):
    """Wraps a transport so each request dials the address its host was checked at.

    A transport rather than an event hook or a wrapper around the adapter,
    because this has to be the last thing before the socket. Anything higher up
    leaves httpx a hostname to resolve for itself, which is the whole defect.
    """

    def __init__(self, inner: httpx.AsyncBaseTransport) -> None:
        """Take ownership of the transport that will carry the pinned request."""
        self._inner = inner

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        """Dial a checked address, or refuse without handing anything inward.

        The raise sits outside every ``except`` deliberately. A resolver's own
        exception quotes the name it failed on, which came out of a request body,
        so letting one be active here would attach it as ``__cause__`` or
        ``__context__`` and put that value in a traceback this seam promises
        never to repeat.
        """
        addresses = await _checked_dial_addresses(request.url.host)
        if not addresses:
            _LOGGER.warning(_REFUSED_EVENT)
            raise ForbiddenDestinationError(_REFUSED_MESSAGE, request=request)
        return await self._dial_in_turn(request, addresses)

    async def _dial_in_turn(
        self, request: httpx.Request, addresses: tuple[str, ...]
    ) -> httpx.Response:
        """Dial the approved addresses in resolver order until one connects.

        **Pinning decides where a socket may open, not how few of those places
        may be tried.** Dialling only the first answer would hand back the
        fallback httpx was already doing for free: it staggers a happy-eyeballs
        attempt across both families, and ``getaddrinfo`` puts the AAAA first, so
        a pin on answer zero pins IPv6 for every dual-stack name. On a deployment
        with no IPv6 egress -- the ordinary container and VPC shape -- every such
        vault would hard-fail the day the pin shipped, with nothing about the
        vault having changed, and it would surface as an unnameable
        ``ConnectError`` rather than as anything an operator could act on.

        **The fallback is safety-neutral by construction rather than by care.**
        :func:`_refuses` condemns the WHOLE destination when ANY answer is
        blocked, so every address still in hand passed the identical predicate.
        There is no address here the pin would have refused, and therefore no
        order of trying them that reaches anywhere the first one could not.

        **Replaying the body is sound because of how these requests are built.**
        Every vault request is constructed from ``json=``, whose stream re-yields
        the same bytes on each iteration, so the second attempt carries what the
        first one did. A copy that dropped the body would send nothing beneath
        the ``Content-Length`` it kept -- a truncated write that looks complete
        to everything between here and the vault.

        The last address is dialled outside the ``try`` so its failure propagates
        exactly as it was raised. Restating it as a refusal would report a broken
        network as a destination this server declined, which sends an operator to
        the URL when they should be looking at the vault, and would give the
        refusal a ``__cause__`` quoting an address resolved from a name that
        arrived in a request body.
        """
        for address in addresses[:-1]:
            try:
                return await self._inner.handle_async_request(_pinned_request(request, address))
            except _NEXT_ADDRESS_ERRORS:
                continue
        return await self._inner.handle_async_request(_pinned_request(request, addresses[-1]))

    async def aclose(self) -> None:
        """Release the wrapped transport, whose connection pool this does not own twice."""
        await self._inner.aclose()


def build_pinned_destination_transport() -> PinnedDestinationTransport:
    """Build the production pinning transport over a keep-alive-free HTTP transport."""
    return PinnedDestinationTransport(httpx.AsyncHTTPTransport(limits=PINNED_CONNECTION_LIMITS))


async def _checked_dial_addresses(host: str) -> tuple[str, ...]:
    """Return every address ``host`` may be dialled at, empty if it may not be.

    Empty rather than ``None``: an approval and a choice of address are two
    different facts, and a ``str | None`` encoded both in one value, so the
    caller could not learn "refused" without also being handed the one answer it
    was allowed to use. The order is the resolver's own, because that is the
    order the platform prefers and the caller walks it in turn.

    An empty host is refused without asking, because asking answers dangerously:
    ``getaddrinfo("")`` reports this machine's own loopback, so a transport that
    resolved it would find the hole by walking into it -- and would pin to it,
    which is worse than passing the empty host along.
    """
    if not host:
        return ()
    addresses = await _dial_candidates(host)
    return () if _refuses(addresses) else addresses


async def _dial_candidates(host: str) -> tuple[str, ...]:
    """Return every address ``host`` could be dialled at, empty if none was established.

    The degrade set is wider than the one failure worth naming, and matches the
    resolving half's for the same reasons: ``socket.gaierror`` is NXDOMAIN and an
    unreachable resolver alike, its base ``OSError`` covers a socket layer
    refusing for a reason of its own, and ``UnicodeError`` covers a label IDNA
    cannot encode. Every one of them means nobody established where this host
    points, and an unestablished destination is an unchecked one. Nothing is
    bound, because a resolver's message quotes the submitted name.
    """
    if creek_vault_url_resolution.host_is_address_literal(host):
        return (host,)
    try:
        return await creek_vault_url_resolution.resolve_host_addresses(host)
    except (OSError, UnicodeError):
        return ()


def _refuses(addresses: tuple[str, ...]) -> bool:
    """Report whether these answers condemn the destination they came from.

    An empty answer leaves nothing to pin, and one blocked answer condemns the
    name rather than being filtered out of it.
    """
    return not addresses or any(address_is_blocked(address) for address in addresses)


def _pinned_request(request: httpx.Request, address: str) -> httpx.Request:
    """Copy ``request`` with its host replaced by ``address`` and its name carried on.

    A new request rather than an edit of the caller's: httpx hands the same
    object back on a redirect, in an event hook, and on the exception it raises,
    so a mutation would leak an address into places meant to show a hostname and
    would make a retry pin to the previous attempt's answer.

    Passing ``stream`` is what carries the BODY across. Without it httpx runs its
    own request preparation, and preparation with no content produces an empty
    body -- while the ``Content-Length`` copied off the original survives it
    untouched. Every journal write to a connected vault would then arrive
    truncated beneath a header stating it was whole: no error, no 4xx, nothing
    the caller can see, and a stored entry that is simply blank. The ``Host``
    header is not what is at stake here, tempting as it is to say so: on this
    branch preparation does not run at all, and on the branch without ``stream``
    it sets ``Host`` only where nothing set it already. Either way the copied
    headers carry it through; only the body does not.

    The extensions are merged rather than replaced because httpx carries the
    per-request timeout budget in that dict, and a replacing write would drop the
    vault's whole deadline invisibly.
    """
    return httpx.Request(
        request.method,
        request.url.copy_with(host=address),
        headers=request.headers,
        stream=request.stream,
        # httpcore reads this and passes it as the TLS ``server_hostname``.
        # Without it the certificate is verified against the pinned address,
        # which proves nothing about the vault, and the pin becomes a downgrade.
        extensions={**request.extensions, "sni_hostname": request.url.host},
    )
