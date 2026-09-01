"""The address a user's vault URL was approved at is the address the socket opens to.

The rest of the request-forgery guard decides *whether* a user-supplied vault may
be dialled. This file is about the gap between that decision and the dial. The
guard resolves a name, judges every answer, and hands httpx a URL that still
names the name -- so httpx resolves it again when it connects, and the second
answer is the one the socket gets. A zone whose record flips between those two
moments passes a check against ``8.8.8.8`` and opens a connection to ``10.0.0.7``,
carrying the bearer credential the user supplied. Nothing in the earlier guard
can close that: it is not a missing rule, it is a second lookup nobody asked for.

So the approved address is pinned into the request. One lookup, its answer
written into the URL, the original hostname carried onward as the TLS server name
and in the ``Host`` header so the certificate and the vhost still work.

**Every case drives the transport object itself.** The seam most of this feature's
neighbours are tested through -- injecting an ``httpx.AsyncClient`` into
:class:`~services.creek_vault_client.HttpCreekVaultClient` -- would leave the
transport unexercised: a test that injects a bare ``MockTransport`` client stays
green against a pin that never runs, which is the exact failure this file exists
to make impossible. The one exception is the degrade case, whose whole subject is
what a caller upstream sees, and it injects a client whose transport *is* the
pinned one.

**The resolver is patched as a module attribute, deliberately.** If the transport
had imported the lookup by bound name, ``setattr`` on the resolver module would
not reach it: the real ``getaddrinfo`` would run against ``vault.example.com``,
answer NXDOMAIN, and the transport would refuse -- and every refusal case here
would pass for a reason that has nothing to do with what it claims to assert.
That is why the stub counts its calls and why at least one case asserts the count
rather than the refusal. A refusal alone proves nothing about which code ran.

The uncached lookup is the one used, not the sixty-second verdict cache the write
path shares. Pinning to a cached verdict would re-open the same staleness window
one layer down, which is the whole of what this file is here to close.
"""

from __future__ import annotations

import ipaddress
import logging
import socket
from collections.abc import Awaitable, Callable
from http import HTTPStatus

import httpx
import pytest

from services import creek_vault_url_resolution
from services.creek_vault_client import (
    _HTTP_CALL_FAILED_ERRORS,
    _VAULT_HTTP_TIMEOUT,
    HandshakeDegradeReason,
    HttpCreekVaultClient,
)
from services.creek_vault_pinned_transport import (
    _MAX_PINNED_CONNECTIONS,
    _REFUSED_EVENT,
    PINNED_CONNECTION_LIMITS,
    ForbiddenDestinationError,
    PinnedDestinationTransport,
    build_pinned_destination_transport,
)

# A name with nothing suspicious about its spelling, so every refusal below is
# about what it resolves to rather than about how it reads.
_VAULT_HOST = "vault.example.com"
_VAULT_URL = f"https://{_VAULT_HOST}"
_CAPABILITIES_URL = f"{_VAULT_URL}/v1/capabilities"

# A write, because a write is the request that carries a body and the body is
# the part a faithless copy loses. Its content is a writer's sentence rather
# than a token, so an assertion that finds it missing reads as what it is.
_ENTRY_URL = f"{_VAULT_URL}/v1/collections/journal/entries/an-entry"
_ENTRY_BODY = {"entry": "a line the writer had just finished typing"}

# Genuinely globally-routable addresses. Documentation ranges are the tempting
# choice and are wrong: ``ipaddress`` reports TEST-NET and ``2001:db8::/32`` as
# not globally routable, so a correct guard blocks them and every approval case
# built on one would fail against working code.
_GLOBAL_ADDRESS = "8.8.8.8"
_SECOND_GLOBAL_ADDRESS = "93.184.216.34"
_GLOBAL_V6_ADDRESS = "2606:4700::1111"

# The cloud metadata endpoint, and the shape it arrives in on an IPv6-only
# deployment: a DNS64 resolver synthesizes an AAAA by dropping the A record into
# the low 32 bits of the well-known NAT64 prefix, so this literal and the IPv4
# one below name one destination. ``ipaddress`` reports the synthesized form as
# globally routable, which is exactly why it needs a case of its own here.
_METADATA_ADDRESS = "169.254.169.254"
_NAT64_METADATA_ADDRESS = "64:ff9b::a9fe:a9fe"

# The same synthesis performed on an ordinary public host (93.184.216.34). It is
# what a legitimate vault looks like from an IPv6-only deployment, and it is the
# reason the rule upstream unwraps the embedded address rather than refusing the
# prefix: a ban would take the vault away from everybody on such a network.
_NAT64_PUBLIC_ADDRESS = "64:ff9b::5db8:d822"

# What the transport underneath says when a dial fails. Distinct from anything
# this module raises, so a case can tell the network's own failure from a refusal
# wearing its clothes. Worded for every failure the stub is given rather than for
# a refused connect alone, since it also stands in for a timeout and for a
# failure that arrives after the connection landed.
_STUBBED_DIAL_FAILURE = "stubbed: the transport underneath failed this dial"

# Addresses reachable from inside a deployment and from nowhere else.
_PRIVATE_ADDRESS = "10.0.0.7"
_PRIVATE_V6_ADDRESS = "fd00::1"

# The credential the degrade case dials with. Distinctive so its appearance
# anywhere it should not be is unambiguous.
_API_KEY = "PINNED-DIAL-TEST-CREDENTIAL"  # pragma: allowlist secret

# A hostname distinctive enough that finding it in a refusal can only mean the
# refusal repeated a value that arrived in a request body next to a credential.
_SENTINEL_HOST = "sentinel-vault-host-do-not-echo.example.com"

# A per-request timeout budget, written the way httpx writes it: the four phase
# budgets nested under one ``timeout`` key, which is the shape ``build_request``
# actually produces. It is here to prove the rewrite merges the caller's
# extensions rather than replacing them -- a replacing dict drops this silently
# and the vault's whole deadline with it.
_TIMEOUT_BUDGET = {"connect": 1.0, "read": 1.0, "write": 1.0, "pool": 1.0}
_TIMEOUT_EXTENSION = {"timeout": _TIMEOUT_BUDGET}

Resolver = Callable[[str], Awaitable[tuple[str, ...]]]
InnerHandler = Callable[[httpx.Request], httpx.Response]


class _CountingResolver:
    """A resolver stub that answers a scripted sequence and counts every asking.

    The count is the load-bearing part. A stub that only answered could not tell
    a transport that consulted it from one that never did, and "never did" is the
    way this whole file goes vacuously green.
    """

    def __init__(self, *answers: tuple[str, ...]) -> None:
        """Store the answers, handed out in order with the last one repeating."""
        self._answers = answers
        self.calls: list[str] = []

    async def __call__(self, host: str) -> tuple[str, ...]:
        """Record the name asked about and return the next scripted answer."""
        self.calls.append(host)
        return self._answers[min(len(self.calls) - 1, len(self._answers) - 1)]


class _InnerRecorder:
    """Handler that records whatever the pinned transport handed inward."""

    def __init__(self) -> None:
        """Start with an empty request log."""
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record the request and answer with an empty 200."""
        self.requests.append(request)
        return httpx.Response(HTTPStatus.OK, json={})


class _RefusingInnerRecorder:
    """Handler that fails the addresses it was named and records every attempt.

    A refused connection is what a dual-stack vault looks like from a deployment
    that has egress on only one family, and the exception type is the whole
    signal: nothing else distinguishes "this address is unreachable from here"
    from "this vault is down". The bodies are kept because a fallback that
    re-sends nothing is invisible from the request log alone, and the raised
    errors are kept because one case asserts on the identity of the one that
    escaped rather than merely on its type.

    The failure class is a parameter because the transport's decision to move on
    is a decision about *which* failures, and cases exist here for a failure that
    should advance and for one that must not. ``httpx.ConnectError`` is the
    default so every case that predates the parameter reads and behaves exactly
    as it did.
    """

    def __init__(
        self, *refused: str, error: type[httpx.TransportError] = httpx.ConnectError
    ) -> None:
        """Fail every dial naming one of ``refused`` with ``error`` and answer the rest."""
        self._refused = frozenset(refused)
        self._error = error
        self.requests: list[httpx.Request] = []
        self.bodies: list[bytes] = []
        self.errors: list[httpx.TransportError] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record the attempt, then fail it or answer it naming what was dialled."""
        self.requests.append(request)
        self.bodies.append(request.read())
        if request.url.host in self._refused:
            error = self._error(_STUBBED_DIAL_FAILURE, request=request)
            self.errors.append(error)
            raise error
        return httpx.Response(HTTPStatus.OK, json={"dialled": request.url.host})


class _ClosableInner(httpx.AsyncBaseTransport):
    """Inner transport that remembers whether it was closed."""

    def __init__(self) -> None:
        """Start unclosed."""
        self.closed = False

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        """Answer any request with a 200 naming the URL it was asked for."""
        return httpx.Response(HTTPStatus.OK, json={"url": str(request.url)})

    async def aclose(self) -> None:
        """Record that the wrapper released this transport."""
        self.closed = True


class _TransportBuildRecorder:
    """Stand-in for ``httpx.AsyncHTTPTransport`` that records how it was constructed.

    Keyword-only, so a builder that passed the limits positionally would fail
    here rather than quietly satisfy the assertion.
    """

    def __init__(self) -> None:
        """Start with no recorded constructions."""
        self.limits: list[httpx.Limits] = []

    def __call__(self, *, limits: httpx.Limits) -> httpx.AsyncBaseTransport:
        """Record the limits asked for and hand back an inert transport."""
        self.limits.append(limits)
        return _ClosableInner()


def _install_resolver(monkeypatch: pytest.MonkeyPatch, resolver: Resolver) -> None:
    """Point the uncached lookup at ``resolver`` for the duration of one test."""
    monkeypatch.setattr(creek_vault_url_resolution, "resolve_host_addresses", resolver)


def _resolver_raising(error: Exception) -> Resolver:
    """Build a resolver stub whose every lookup fails with ``error``."""

    async def _stub(_host: str) -> tuple[str, ...]:
        raise error

    return _stub


def _pinned_around(handler: InnerHandler) -> PinnedDestinationTransport:
    """Wrap a mock transport answering from ``handler`` in the transport under test."""
    return PinnedDestinationTransport(httpx.MockTransport(handler))


def _dialled_hosts(recorder: _RefusingInnerRecorder) -> list[str]:
    """Return the host of every dial that reached the transport underneath, in order."""
    return [request.url.host for request in recorder.requests]


# ---------------------------------------------------------------------------
# The pin itself: one lookup, and its answer is what gets dialled
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_dial_names_the_address_the_check_passed_not_a_second_lookups_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The approved address travels into the URL, and nothing looks the name up again.

    The stub answers publicly once and privately after, which is rebinding
    written down. A transport that left the hostname in the URL would hand httpx
    a second lookup to make at connect time, and the private answer is the one
    the socket would get. Both assertions are needed and neither implies the
    other: the first says the right address was chosen, the second says there was
    no second chance to choose a different one -- and it is also what proves the
    stub was reached at all.
    """
    resolver = _CountingResolver((_GLOBAL_ADDRESS,), (_PRIVATE_ADDRESS,))
    _install_resolver(monkeypatch, resolver)
    recorder = _InnerRecorder()
    transport = _pinned_around(recorder)

    await transport.handle_async_request(httpx.Request("GET", _CAPABILITIES_URL))

    assert len(recorder.requests) == 1
    assert recorder.requests[0].url.host == _GLOBAL_ADDRESS
    assert len(resolver.calls) == 1


@pytest.mark.asyncio
async def test_the_pinned_dial_carries_the_original_hostname_as_its_tls_server_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The TLS handshake still asks for the name the user typed, not the address.

    Deliberately asserts nothing else. Rewriting the host and setting the server
    name are two separate mistakes to make, and a test that checked both would go
    red for either -- leaving nobody able to say from the failure which half
    broke. This case owns the server name and the case above owns the address.
    """
    _install_resolver(monkeypatch, _CountingResolver((_GLOBAL_ADDRESS,)))
    recorder = _InnerRecorder()
    transport = _pinned_around(recorder)

    await transport.handle_async_request(httpx.Request("GET", _CAPABILITIES_URL))

    assert recorder.requests[0].extensions["sni_hostname"] == _VAULT_HOST


@pytest.mark.asyncio
async def test_the_rebound_request_keeps_the_host_header_the_user_named(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A vault behind a name-based vhost is still routed to the right vault.

    The address is a transport-layer fact and the ``Host`` header is an
    application-layer one. Rewriting the second along with the first would aim a
    correct connection at the wrong site on a shared host.
    """
    _install_resolver(monkeypatch, _CountingResolver((_GLOBAL_ADDRESS,)))
    recorder = _InnerRecorder()
    transport = _pinned_around(recorder)

    await transport.handle_async_request(httpx.Request("GET", _CAPABILITIES_URL))

    assert recorder.requests[0].headers["Host"] == _VAULT_HOST


@pytest.mark.asyncio
async def test_the_callers_own_request_still_names_the_host_it_named(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The rewrite builds a new request rather than editing the caller's.

    httpx hands the same request object back to the caller on a redirect, in an
    event hook, and on the exception it raises, so a transport that mutated it
    would leak an address into places that are supposed to show a hostname -- and
    would make a retry pin to an answer from the previous attempt.
    """
    _install_resolver(monkeypatch, _CountingResolver((_GLOBAL_ADDRESS,)))
    transport = _pinned_around(_InnerRecorder())
    request = httpx.Request("GET", _CAPABILITIES_URL)

    await transport.handle_async_request(request)

    assert request.url.host == _VAULT_HOST
    assert "sni_hostname" not in request.extensions


# ---------------------------------------------------------------------------
# Every approved address, in the order the resolver gave them
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_first_approved_address_is_the_one_dialled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Trying the next address on failure must not become trying all of them always.

    The resolver put its answers in the order the platform preferred, and an
    answer that connects ends the matter. A transport that dialled the whole set
    would turn one vault write into as many writes as the name has records, and
    the vault would see the duplicates rather than the caller.
    """
    _install_resolver(monkeypatch, _CountingResolver((_GLOBAL_ADDRESS, _SECOND_GLOBAL_ADDRESS)))
    recorder = _RefusingInnerRecorder()
    transport = _pinned_around(recorder)

    response = await transport.handle_async_request(httpx.Request("GET", _CAPABILITIES_URL))

    assert _dialled_hosts(recorder) == [_GLOBAL_ADDRESS]
    assert response.json()["dialled"] == _GLOBAL_ADDRESS


@pytest.mark.parametrize(
    "unreached",
    [httpx.ConnectError, httpx.ConnectTimeout],
    ids=["connection_refused", "connect_timed_out"],
)
@pytest.mark.asyncio
async def test_a_connection_that_was_never_made_falls_over_to_the_next_approved_address(
    monkeypatch: pytest.MonkeyPatch, unreached: type[httpx.TransportError]
) -> None:
    """Pinning decides *where* a socket may open, not how few of those places may be tried.

    Giving up after the first address hands back the fallback httpx was already
    doing: it staggers a happy-eyeballs attempt across both families, so a
    dual-stack vault whose AAAA is unreachable from a deployment with no IPv6
    egress connects today and would hard-fail the day the pin shipped -- with
    nothing about the vault having changed.

    The fallback is safety-neutral by construction rather than by care. The whole
    destination is refused when *any* answer is blocked, so every address still
    in hand passed the identical predicate; the second one cannot reach anywhere
    the first was not already allowed to reach.

    Both classes, because they are the two shapes of "no connection was made" and
    they sit in disjoint branches of httpx's hierarchy: a refused connect is a
    ``NetworkError`` and a timed-out one is a ``TimeoutException``, so the
    obvious one-element set of failures to move on from covers only half the
    case -- and it is the half nobody sees, since a dead family in a cloud
    security group drops packets silently and therefore times out rather than
    being refused.
    """
    _install_resolver(monkeypatch, _CountingResolver((_GLOBAL_ADDRESS, _SECOND_GLOBAL_ADDRESS)))
    recorder = _RefusingInnerRecorder(_GLOBAL_ADDRESS, error=unreached)
    transport = _pinned_around(recorder)

    response = await transport.handle_async_request(httpx.Request("GET", _CAPABILITIES_URL))

    assert _dialled_hosts(recorder) == [_GLOBAL_ADDRESS, _SECOND_GLOBAL_ADDRESS]
    assert response.json()["dialled"] == _SECOND_GLOBAL_ADDRESS


@pytest.mark.asyncio
async def test_a_failure_after_the_connection_landed_is_not_retried_elsewhere(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A landed request may already have been acted on, so it is never sent twice.

    This is the whole safety argument for retrying at all. Moving on after a
    refused or timed-out connect costs nothing, because no connection was made
    and the vault never heard the request. A read or write failure is the
    opposite news wearing the same coat: the connection LANDED, the vault may
    have applied the write and failed on the way back, and re-sending it to
    another address would be this seam deciding on its own to repeat a write
    nobody asked it to repeat -- a duplicated journal entry the writer never
    typed twice, arrived at by a code path that only runs on multi-record names.

    Both halves are asserted. That the error escapes unchanged says the caller
    still sees what happened; that no second dial occurred says the seam did not
    quietly try again first, which is the part a widened failure set would break
    while leaving the exception type intact.
    """
    _install_resolver(monkeypatch, _CountingResolver((_GLOBAL_ADDRESS, _SECOND_GLOBAL_ADDRESS)))
    recorder = _RefusingInnerRecorder(_GLOBAL_ADDRESS, error=httpx.ReadError)
    transport = _pinned_around(recorder)

    with pytest.raises(httpx.ReadError) as caught:
        await transport.handle_async_request(httpx.Request("GET", _CAPABILITIES_URL))

    assert caught.value is recorder.errors[-1]
    assert _dialled_hosts(recorder) == [_GLOBAL_ADDRESS]


@pytest.mark.asyncio
async def test_a_retried_dial_resends_the_body_it_was_given(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A retry that forgets the body writes an empty entry and calls it a success.

    The second attempt is built from the same stream the first one read. If that
    stream does not replay, the vault receives no bytes at all beneath the
    ``Content-Length`` copied from the original -- a truncated write that looks
    complete to everything between here and the vault, and that happens only on
    the deployments where the first address is unreachable, which is to say
    nowhere anybody develops.
    """
    _install_resolver(monkeypatch, _CountingResolver((_GLOBAL_ADDRESS, _SECOND_GLOBAL_ADDRESS)))
    recorder = _RefusingInnerRecorder(_GLOBAL_ADDRESS)
    transport = _pinned_around(recorder)
    request = httpx.Request("PUT", _ENTRY_URL, json=_ENTRY_BODY)

    await transport.handle_async_request(request)

    written = request.read()
    assert written != b""
    assert recorder.bodies == [written, written]


@pytest.mark.asyncio
async def test_the_last_address_failing_raises_what_the_transport_underneath_raised(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A network that failed must not be reported as a destination this server refused.

    They are opposite news wearing one type. One says the vault is down or the
    route to it is broken and an operator should look at the vault; the other
    says this server declined to dial what its owner named and an operator should
    look at the URL. Restating the last failure as a refusal also gives that
    refusal a ``__cause__`` quoting an address a resolver returned for a name
    that arrived in a request body, which this seam promises never to repeat.
    """
    _install_resolver(monkeypatch, _CountingResolver((_GLOBAL_ADDRESS, _SECOND_GLOBAL_ADDRESS)))
    recorder = _RefusingInnerRecorder(_GLOBAL_ADDRESS, _SECOND_GLOBAL_ADDRESS)
    transport = _pinned_around(recorder)

    with pytest.raises(httpx.ConnectError) as caught:
        await transport.handle_async_request(httpx.Request("GET", _CAPABILITIES_URL))

    assert caught.value is recorder.errors[-1]
    assert not isinstance(caught.value, ForbiddenDestinationError)
    assert _dialled_hosts(recorder) == [_GLOBAL_ADDRESS, _SECOND_GLOBAL_ADDRESS]


@pytest.mark.asyncio
async def test_a_dual_stack_name_is_pinned_to_a_literal_from_each_family_in_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``getaddrinfo`` answers AAAA first, so pinning the first answer pins IPv6 always.

    That ordering is not this vault's accident, it is what the resolver does for
    every dual-stack name. A deployment with no IPv6 egress -- the ordinary
    container and VPC shape -- would therefore lose every vault publishing both
    records, and lose it on the day the pin shipped. Walking the families in the
    resolver's own order is what keeps this a security change rather than an
    availability one, and the answers are written in that order here for the
    same reason.
    """
    _install_resolver(monkeypatch, _CountingResolver((_GLOBAL_V6_ADDRESS, _GLOBAL_ADDRESS)))
    recorder = _RefusingInnerRecorder(_GLOBAL_V6_ADDRESS)
    transport = _pinned_around(recorder)

    await transport.handle_async_request(httpx.Request("GET", _CAPABILITIES_URL))

    first, second = recorder.requests
    assert str(first.url) == f"https://[{_GLOBAL_V6_ADDRESS}]/v1/capabilities"
    assert str(second.url) == f"https://{_GLOBAL_ADDRESS}/v1/capabilities"


# ---------------------------------------------------------------------------
# Refusals, and the dial that never happened
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_name_resolving_to_a_private_address_is_refused_before_any_dial(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The refusal is a refusal: no request reaches the transport underneath.

    Raising after handing the request onward would be the shape of the bug this
    file exists for, and it looks identical from the caller's side.
    """
    _install_resolver(monkeypatch, _CountingResolver((_PRIVATE_ADDRESS,)))
    recorder = _InnerRecorder()
    transport = _pinned_around(recorder)

    with pytest.raises(ForbiddenDestinationError):
        await transport.handle_async_request(httpx.Request("GET", _CAPABILITIES_URL))

    assert recorder.requests == []


@pytest.mark.asyncio
async def test_a_public_a_record_beside_a_private_aaaa_refuses_the_whole_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One bad answer condemns the name, rather than being filtered out of it.

    Pinning the surviving address is the tempting repair and it is wrong twice
    over: the name still points somewhere internal, and whoever controls the zone
    chooses which record survives the filter next time. The whole destination is
    refused, and which family the bad answer came from does not enter into it.
    """
    _install_resolver(monkeypatch, _CountingResolver((_SECOND_GLOBAL_ADDRESS, _PRIVATE_V6_ADDRESS)))
    recorder = _InnerRecorder()
    transport = _pinned_around(recorder)

    with pytest.raises(ForbiddenDestinationError):
        await transport.handle_async_request(httpx.Request("GET", _CAPABILITIES_URL))

    assert recorder.requests == []


@pytest.mark.asyncio
async def test_a_private_a_record_beside_a_public_aaaa_refuses_too(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The order of the answers decides nothing.

    This case is satisfied by a guard that checks only the first address; its
    sibling above, whose bad answer arrives second, is not. Together they say the
    rule is "every answer", which is the only rule that holds when the answers
    arrive in an order we did not choose.
    """
    _install_resolver(monkeypatch, _CountingResolver((_PRIVATE_ADDRESS, _GLOBAL_V6_ADDRESS)))
    recorder = _InnerRecorder()
    transport = _pinned_around(recorder)

    with pytest.raises(ForbiddenDestinationError):
        await transport.handle_async_request(httpx.Request("GET", _CAPABILITIES_URL))

    assert recorder.requests == []


@pytest.mark.asyncio
async def test_a_name_resolving_to_nothing_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An empty answer leaves nothing to pin, so there is nothing to dial.

    Falling through to the hostname here would be the quiet reintroduction of the
    entire defect: an unpinned URL is one httpx resolves for itself.
    """
    _install_resolver(monkeypatch, _CountingResolver(()))
    recorder = _InnerRecorder()
    transport = _pinned_around(recorder)

    with pytest.raises(ForbiddenDestinationError):
        await transport.handle_async_request(httpx.Request("GET", _CAPABILITIES_URL))

    assert recorder.requests == []


@pytest.mark.parametrize(
    "error",
    [socket.gaierror(socket.EAI_NONAME, "stubbed"), UnicodeError("stubbed")],
    ids=["lookup_failed", "name_not_encodable"],
)
@pytest.mark.asyncio
async def test_a_resolver_that_fails_refuses_rather_than_dialling(
    monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    """Fail closed on both ways a lookup can end without an answer.

    ``gaierror`` is NXDOMAIN and an unreachable resolver alike; ``UnicodeError``
    is a label IDNA cannot encode. Neither established where the host points, and
    an unestablished destination is an unchecked one. Letting either escape as
    itself would also put a novel exception type on a per-request path, which the
    degrade sets downstream have no clause for.
    """
    _install_resolver(monkeypatch, _resolver_raising(error))
    recorder = _InnerRecorder()
    transport = _pinned_around(recorder)

    with pytest.raises(ForbiddenDestinationError):
        await transport.handle_async_request(httpx.Request("GET", _CAPABILITIES_URL))

    assert recorder.requests == []


@pytest.mark.asyncio
async def test_a_request_naming_no_host_is_refused_rather_than_looked_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An empty host is refused without asking, because asking answers dangerously.

    ``getaddrinfo("")`` reports this machine's own loopback, so a transport that
    resolved the empty string would find the hole by walking into it -- and would
    pin to it, which is worse than passing it along.
    """
    resolver = _CountingResolver((_GLOBAL_ADDRESS,))
    _install_resolver(monkeypatch, resolver)
    recorder = _InnerRecorder()
    transport = _pinned_around(recorder)

    with pytest.raises(ForbiddenDestinationError):
        await transport.handle_async_request(httpx.Request("GET", "https:///v1/capabilities"))

    assert resolver.calls == []
    assert recorder.requests == []


@pytest.mark.asyncio
async def test_a_name_answered_only_by_a_nat64_synthesis_of_metadata_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """On an IPv6-only network this is the only shape the metadata endpoint has.

    A DNS64 resolver answers every name that has no AAAA by dropping its A record
    into the low 32 bits of the well-known NAT64 prefix, so an attacker who owns
    a zone points its A record at the metadata endpoint and what arrives here is
    an address ``ipaddress`` calls globally routable. This is the last judgement
    before the socket, so if the pin and the predicate disagree about this
    address the pin is what certifies it.

    The fixture is checked against the address it claims to embed, because a
    mistyped literal would be refused for some other reason and the case would
    pass while proving nothing.
    """
    embedded = ipaddress.IPv6Address(_NAT64_METADATA_ADDRESS).packed[-4:]
    assert embedded == ipaddress.IPv4Address(_METADATA_ADDRESS).packed

    _install_resolver(monkeypatch, _CountingResolver((_NAT64_METADATA_ADDRESS,)))
    recorder = _InnerRecorder()
    transport = _pinned_around(recorder)

    with pytest.raises(ForbiddenDestinationError):
        await transport.handle_async_request(httpx.Request("GET", _CAPABILITIES_URL))

    assert recorder.requests == []


@pytest.mark.asyncio
async def test_a_nat64_synthesis_of_an_ordinary_public_vault_is_still_dialled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The rule for these addresses is an unwrap, and this is what the unwrap is for.

    Refusing the well-known prefix outright would be the shorter rule and it
    would take the vault away from every IPv6-only deployment at once -- there,
    a synthesized AAAA is not an exotic answer, it is the only answer any name
    ever has. Judging the address the prefix carries refuses the metadata case
    next door and keeps this one, which is the entire difference between a guard
    and an outage.

    The fixture is checked against the address it claims to embed, exactly as its
    refused twin is. A mistyped nibble here would still be a globally-routable
    address and would still be dialled, so the case would pass while saying
    nothing about the unwrap it exists to exercise -- it would merely have named
    an unrelated host.
    """
    embedded = ipaddress.IPv6Address(_NAT64_PUBLIC_ADDRESS).packed[-4:]
    assert embedded == ipaddress.IPv4Address(_SECOND_GLOBAL_ADDRESS).packed

    _install_resolver(monkeypatch, _CountingResolver((_NAT64_PUBLIC_ADDRESS,)))
    recorder = _InnerRecorder()
    transport = _pinned_around(recorder)

    await transport.handle_async_request(httpx.Request("GET", _CAPABILITIES_URL))

    assert recorder.requests[0].url.host == _NAT64_PUBLIC_ADDRESS
    assert recorder.requests[0].extensions["sni_hostname"] == _VAULT_HOST


# ---------------------------------------------------------------------------
# What a refusal costs the caller, and what it says
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_refusal_degrades_the_handshake_rather_than_raising_to_the_caller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A refused destination costs its owner the vault and never their writing.

    This is the case that matters most, and the only one here that goes through
    the adapter. The vault runs inside a per-request dependency: an exception
    escaping this transport means the handler body never executes and the entry
    the writer just typed is lost to save them from a connection they never saw.
    So the refusal has to arrive as something the existing degrade already
    understands, and the assertion is on the reason rather than merely on
    "unavailable" -- a refusal counted as a timeout would send an operator
    hunting for capacity on a vault that was never dialled.
    """
    _install_resolver(monkeypatch, _CountingResolver((_PRIVATE_ADDRESS,)))
    transport = _pinned_around(_InnerRecorder())

    async with httpx.AsyncClient(transport=transport, timeout=_VAULT_HTTP_TIMEOUT) as http_client:
        client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_client)
        result = await client.handshake()

        assert result.available is False
        assert client.last_degrade_reason is HandshakeDegradeReason.UNREACHABLE


def test_the_refusal_is_a_connect_error_the_existing_degrade_sets_already_cover() -> None:
    """The refusal is an ``httpx.ConnectError``, which is what makes the degrade work.

    Asserted on the type rather than only through a handshake, because the
    handshake case can be satisfied by a coincidence -- some other clause
    catching some other error -- while this states the contract the degrade
    depends on. A refusal outside these sets is an exception on a writer's
    request path.
    """
    assert issubclass(ForbiddenDestinationError, httpx.ConnectError)
    assert isinstance(ForbiddenDestinationError("refused"), _HTTP_CALL_FAILED_ERRORS)


@pytest.mark.asyncio
async def test_the_refusal_names_no_host_it_was_given(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A refusal quotes nothing that arrived in a request body.

    The host came from a submitted URL, alongside the bearer key, and this
    exception travels into logs and onward into whatever renders a degrade.

    The exception does still carry the host, on ``request.url`` -- that is
    deliberate, since ``httpx.RequestError.request`` raises when unset. What is
    asserted is that neither rendering reaches it: the str is the message, and
    the repr is built from ``args``, which is why it is checked separately. A
    refusal that folded the host into its message would satisfy neither.
    """
    _install_resolver(monkeypatch, _CountingResolver((_PRIVATE_ADDRESS,)))
    transport = _pinned_around(_InnerRecorder())

    with pytest.raises(ForbiddenDestinationError) as caught:
        await transport.handle_async_request(httpx.Request("GET", f"https://{_SENTINEL_HOST}/"))

    assert _SENTINEL_HOST not in str(caught.value)
    assert _SENTINEL_HOST not in repr(caught.value)


@pytest.mark.asyncio
async def test_the_refusal_logs_nothing_it_was_given(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The record written on every refusal is the other place the host could leak.

    Its neighbour above protects the exception's two renderings. This protects
    the log line, which fires on the same path, is written for every refusal
    rather than only for the ones somebody catches, and lands in whatever
    aggregator the deployment ships records to -- the least revocable place a
    submitted value can end up.

    Both the message and the record's attributes are checked, because they leak
    by different means: a value folded into the text, or one attached as a field
    through ``extra`` and rendered only by a structured handler, which is
    invisible from the formatted line.

    The record is located by its static event string, which also says the warning
    was emitted at all: a refusal that logged nothing would satisfy every
    absence-of-sentinel assertion here trivially.
    """
    _install_resolver(monkeypatch, _CountingResolver((_PRIVATE_ADDRESS,)))
    transport = _pinned_around(_InnerRecorder())

    with caplog.at_level(logging.WARNING), pytest.raises(ForbiddenDestinationError):
        await transport.handle_async_request(httpx.Request("GET", f"https://{_SENTINEL_HOST}/"))

    refusals = [record for record in caplog.records if record.getMessage() == _REFUSED_EVENT]
    assert len(refusals) == 1
    assert _SENTINEL_HOST not in refusals[0].getMessage()
    assert _SENTINEL_HOST not in str(refusals[0].__dict__)


# ---------------------------------------------------------------------------
# Address literals, which owe no lookup and are still judged
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_public_address_literal_is_dialled_as_written_and_is_its_own_server_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A literal is already pinned, so it costs no lookup and gets none.

    Resolving it could only return the address it was handed, at the price of a
    DNS round trip on a writer's latency budget -- and of a second answer that
    could differ from the first.
    """
    resolver = _CountingResolver((_PRIVATE_ADDRESS,))
    _install_resolver(monkeypatch, resolver)
    recorder = _InnerRecorder()
    transport = _pinned_around(recorder)

    await transport.handle_async_request(
        httpx.Request("GET", f"https://{_GLOBAL_ADDRESS}/v1/capabilities")
    )

    assert recorder.requests[0].url.host == _GLOBAL_ADDRESS
    assert recorder.requests[0].extensions["sni_hostname"] == _GLOBAL_ADDRESS
    assert resolver.calls == []


@pytest.mark.asyncio
async def test_a_private_address_literal_is_refused_by_the_transport_on_its_own() -> None:
    """The transport does not trust that somebody upstream already checked.

    Everything reaching here has passed the write-time and dial-time guards in
    principle, and "in principle" is what a stored row from a restored backup
    breaks. The last thing before the socket is the only place where being sure
    costs nothing.
    """
    recorder = _InnerRecorder()
    transport = _pinned_around(recorder)

    with pytest.raises(ForbiddenDestinationError):
        await transport.handle_async_request(httpx.Request("GET", f"https://{_PRIVATE_ADDRESS}/"))

    assert recorder.requests == []


@pytest.mark.asyncio
async def test_an_ipv6_literal_survives_the_rewrite_bracketed() -> None:
    """An IPv6 destination is still a URL after the rewrite.

    The address a resolver hands back is unbracketed and a URL's authority is
    not, so a rewrite that pasted one into the other would produce a string
    nothing can parse -- and the failure would be an unparseable-URL error rather
    than anything that reads like a destination problem.
    """
    recorder = _InnerRecorder()
    transport = _pinned_around(recorder)

    await transport.handle_async_request(
        httpx.Request("GET", f"https://[{_GLOBAL_V6_ADDRESS}]/v1/capabilities")
    )

    recorded = recorder.requests[0]
    assert recorded.url.host == _GLOBAL_V6_ADDRESS
    assert str(recorded.url) == f"https://[{_GLOBAL_V6_ADDRESS}]/v1/capabilities"
    assert recorded.headers["Host"] == f"[{_GLOBAL_V6_ADDRESS}]"


# ---------------------------------------------------------------------------
# What else the request was carrying
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_extensions_the_client_already_set_survive_the_rewrite(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The server name is added to the caller's extensions, not substituted for them.

    httpx carries the per-request timeout budget in that dict, so a replacing
    write drops the vault's whole deadline and the loss is invisible until
    something hangs. Both keys are asserted together because the merge is the
    property: either alone is satisfied by the wrong implementation.
    """
    _install_resolver(monkeypatch, _CountingResolver((_GLOBAL_ADDRESS,)))
    recorder = _InnerRecorder()
    transport = _pinned_around(recorder)

    await transport.handle_async_request(
        httpx.Request("GET", _CAPABILITIES_URL, extensions=dict(_TIMEOUT_EXTENSION))
    )

    recorded = recorder.requests[0]
    assert recorded.extensions["timeout"] == _TIMEOUT_BUDGET
    assert recorded.extensions["sni_hostname"] == _VAULT_HOST


@pytest.mark.asyncio
async def test_the_rebound_request_carries_the_body_the_caller_wrote(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A copy built without the caller's stream sends nothing under a truthful length.

    httpx prepares a request it was handed no stream for, and preparation with no
    content produces an empty body -- while the ``Content-Length`` copied off the
    original survives it untouched. Every journal write to a connected vault
    would then arrive truncated beneath a header stating it was whole: not an
    error anywhere, not a 4xx, nothing the caller can see, and a stored entry
    that is simply blank.

    The ``Host`` case above does not catch this and cannot. Preparation sets
    ``Host`` with ``setdefault`` and the copied headers already carry it, so that
    assertion stays green against a transport that drops every body it is given.
    The length is asserted beside the bytes for the same reason: either alone is
    satisfied by a copy that is wrong in the other direction.
    """
    _install_resolver(monkeypatch, _CountingResolver((_GLOBAL_ADDRESS,)))
    recorder = _InnerRecorder()
    transport = _pinned_around(recorder)
    request = httpx.Request("PUT", _ENTRY_URL, json=_ENTRY_BODY)

    await transport.handle_async_request(request)

    recorded = recorder.requests[0]
    assert recorded.read() != b""
    assert recorded.read() == request.read()
    assert recorded.headers["content-length"] == request.headers["content-length"]


# ---------------------------------------------------------------------------
# The transport's own lifecycle
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_closing_the_transport_closes_the_one_it_wraps() -> None:
    """The wrapper owns the transport it was handed and releases it on close.

    A wrapper that swallowed ``aclose`` would leak the connection pool underneath
    for the life of the process, and the leak surfaces only at shutdown, as an
    unclosed-client warning nobody attributes to this file.
    """
    inner = _ClosableInner()
    transport = PinnedDestinationTransport(inner)

    await transport.aclose()

    assert inner.closed is True


@pytest.mark.asyncio
async def test_the_pinned_transport_is_built_to_hold_no_connection_open_between_requests(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep-alive is off, and the builder is what turns it off.

    httpcore keys a pooled connection on its origin alone and never consults the
    TLS server name. Once the origin is a pinned address, two vault hostnames
    that happen to resolve to the same address share one connection -- whose
    certificate proved only the first of the two names. The pin would then have
    bought a stale-DNS fix at the price of a cross-vault one.

    Two assertions, because the value and its use fail separately: a constant set
    correctly and never passed leaves keep-alive on, and a builder passing a
    constant somebody later relaxed leaves it on too.
    """
    assert PINNED_CONNECTION_LIMITS.max_keepalive_connections == 0

    recorder = _TransportBuildRecorder()
    monkeypatch.setattr(httpx, "AsyncHTTPTransport", recorder)

    transport = build_pinned_destination_transport()
    await transport.aclose()

    assert recorder.limits == [PINNED_CONNECTION_LIMITS]


def test_the_pinned_pool_is_bounded_by_the_ceiling_the_operator_pool_already_has() -> None:
    """Turning keep-alive off must not quietly take the ceiling off with it.

    ``httpx.Limits`` defaults every field it is not given, so naming only
    ``max_keepalive_connections`` leaves ``max_connections`` at ``None``, and
    httpcore reads that as ``sys.maxsize``. Unbounded is a far worse property
    here than it would be on an ordinary pool: with keep-alive at zero every
    single request opens a fresh TCP and TLS connection, so concurrent journal
    saves have no bound on sockets or file descriptors, and the ``pool`` slice of
    the vault's timeout -- the one meant to shed load rather than exhaust the
    process -- can never engage, because there is never anything to queue behind.

    That the ceiling *is* httpx's own default is not assertable here and is not
    tried: the constant is defined as ``DEFAULT_LIMITS.max_connections``, so
    comparing the two is a value against itself and cannot fail whatever either
    becomes. What is left worth saying is that the default is a number at all --
    if httpx ever spelled "unbounded" as ``None`` there, the ceiling would vanish
    silently, this pool would inherit the vanishing, and every equality anyone
    could write about it would still hold.
    """
    assert _MAX_PINNED_CONNECTIONS is not None
    assert PINNED_CONNECTION_LIMITS.max_connections == _MAX_PINNED_CONNECTIONS
