"""What the one lookup under the request-forgery guard actually asks, and answers.

Its neighbours all repoint :func:`~services.creek_vault_url_resolution.resolve_host_addresses`
itself: ``test_ssrf_vault_url.py`` and ``test_vault_destination_pin.py`` both
substitute the whole function, because a test that consulted the real resolver
would be asserting something about the network the suite happens to run on, and
a rebinding case could not be expressed at all. That is the right seam for
everything those files are about -- and it means nothing anywhere exercises the
real function. This file does, with the resolver underneath it stubbed instead,
so the one thing left unasserted has somewhere to live.

The subject is the *shape* of what comes back rather than the network. What
``getaddrinfo`` returns is one row per address per socket type, so a name with
four records answers eight rows; the guard hands that list to a caller that
dials the entries in turn, and a list where every address appears twice makes
that walk spend two connect budgets on each address before it reaches the next
one. Nothing about that is visible from a stubbed resolver.
"""

from __future__ import annotations

import asyncio
import socket
import time

import pytest

from services import creek_vault_url_resolution
from services.creek_vault_url_resolution import resolve_host_addresses

# A name with nothing suspicious about its spelling: every assertion here is
# about the answer's shape, never about the string that was asked.
_VAULT_HOST = "vault.example.com"

# One dual-stack name's answers, in the shape the platform resolver really
# produces -- measured rather than imagined: ``getaddrinfo("dns.google", None)``
# returns eight rows for four addresses, a datagram row and a stream row for
# each, datagram first. Two addresses are enough to say the same thing.
_V6_ADDRESS = "2001:4860:4860::8888"
_V4_ADDRESS = "8.8.8.8"

AddrInfoRow = tuple[int, int, int, str, tuple[object, ...]]

_DUPLICATED_ANSWERS: tuple[AddrInfoRow, ...] = (
    (socket.AF_INET6, socket.SOCK_DGRAM, socket.IPPROTO_UDP, "", (_V6_ADDRESS, 0, 0, 0)),
    (socket.AF_INET6, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (_V6_ADDRESS, 0, 0, 0)),
    (socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP, "", (_V4_ADDRESS, 0)),
    (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (_V4_ADDRESS, 0)),
)

# Where the socket type sits when ``asyncio`` calls the blocking lookup. The
# event loop passes ``host, port, family, type, proto, flags`` positionally into
# its executor, so the hint arrives as the fourth argument rather than by name --
# and a lookup that asked for no socket type at all leaves a zero there, which is
# what "any" means to ``getaddrinfo`` and is exactly the request that duplicates
# every row.
_SOCKTYPE_ARGUMENT_INDEX = 3
_NO_SOCKTYPE_ASKED = 0

# A budget short enough that a test can outlast it without waiting. The real
# constant is a latency budget for production traffic and is far too long to
# assert against; what is under test is that *a* budget is enforced, so the
# number is shrunk and the behaviour is what is measured.
_SHRUNK_BUDGET_SECONDS = 0.05

# How long the stubbed lookup would take if nothing stopped it: long enough that
# an unbounded resolver cannot finish inside the ceiling below by luck.
_LOOKUP_LONGER_THAN_ANY_BUDGET_SECONDS = 1.0

# The elapsed time this assertion allows: ten times the budget, and half of what
# an unbounded lookup would take. Deliberately loose on the near side, because
# this suite shares a machine with parallel agent work and a tight tolerance
# would report scheduler latency as a missing bound; still comfortably tight on
# the far side, which is the only side that distinguishes the two outcomes.
_GENEROUS_ELAPSED_CEILING_SECONDS = 0.5


class _RecordingGetaddrinfo:
    """Stand-in for ``socket.getaddrinfo`` that answers duplicates and records the asking.

    Answers the same duplicated rows however it is called, on purpose. The
    property worth pinning is that the caller reports each address once, and a
    stub that de-duplicated whenever it was asked politely would let a resolver
    keep its duplicates and still pass -- which is the bug, not the fix.

    Takes its arguments loosely because the event loop, not this test, decides
    how the blocking lookup is invoked.
    """

    def __init__(self) -> None:
        """Start with no recorded lookups."""
        self.calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    def __call__(self, *args: object, **kwargs: object) -> list[AddrInfoRow]:
        """Record how the lookup was asked and hand back the duplicated answer."""
        self.calls.append((args, kwargs))
        return list(_DUPLICATED_ANSWERS)


def _socktypes_asked_for(recorder: _RecordingGetaddrinfo) -> list[object]:
    """Return the socket type requested by each recorded lookup, in order.

    Reads the keyword and the positional spelling alike, since which one arrives
    is the event loop's business rather than the resolver's, and a test that
    understood only one of them would go red on a Python that changed its mind.
    """
    asked: list[object] = []
    for args, kwargs in recorder.calls:
        if "type" in kwargs:
            asked.append(kwargs["type"])
        elif len(args) > _SOCKTYPE_ARGUMENT_INDEX:
            asked.append(args[_SOCKTYPE_ARGUMENT_INDEX])
        else:
            asked.append(_NO_SOCKTYPE_ASKED)
    return asked


@pytest.mark.asyncio
async def test_a_name_answering_the_same_address_twice_is_reported_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A repeated address costs a whole connect budget and buys nothing.

    The caller that dials these answers walks them in turn and moves on only when
    a connect is refused or times out. A dead family on the ordinary cloud shape
    -- packets dropped, no reset -- consumes the full connect budget per attempt,
    and the whole request has a deadline over the top of it. So a list that names
    the same address twice reaches exactly one distinct address before the
    deadline expires, and the fallback to the other family, which is the entire
    reason the walk exists, never happens on precisely the deployments it was
    written for.

    The order is asserted rather than the set, because the platform put these
    answers in the order it prefers and the dial walk follows it. De-duplicating
    by way of a set would preserve the count and discard that.
    """
    monkeypatch.setattr(socket, "getaddrinfo", _RecordingGetaddrinfo())

    addresses = await resolve_host_addresses(_VAULT_HOST)

    assert addresses == (_V6_ADDRESS, _V4_ADDRESS)


@pytest.mark.asyncio
async def test_the_lookup_asks_the_resolver_only_about_the_sockets_it_will_open(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Asking for every socket type is asking for the same answer three times.

    This resolver only ever feeds a TCP dial, so a stream hint is what it means
    rather than an optimisation. Without one, ``getaddrinfo`` answers once per
    socket type per address -- datagram, stream, and raw where the platform
    offers it -- and every one of those rows names a destination already named.
    anyio passes the hint for this reason; this lookup was written without it.

    Asserted beside its sibling above rather than folded into it: the hint and
    the de-duplication fix the same symptom by different means, and either alone
    leaves the other worth having. The hint keeps the guard from asking a
    question whose extra answers it must then throw away, and the de-duplication
    holds whatever a platform's resolver decides to return.
    """
    recorder = _RecordingGetaddrinfo()
    monkeypatch.setattr(socket, "getaddrinfo", recorder)

    await resolve_host_addresses(_VAULT_HOST)

    assert _socktypes_asked_for(recorder) == [socket.SOCK_STREAM]


async def _answering_far_too_late(*_args: object, **_kwargs: object) -> list[AddrInfoRow]:
    """Stand in for a resolver that will answer eventually, and far too late.

    Pure ``asyncio.sleep`` rather than a blocking one, so cancelling it actually
    stops it. A stub that slept in a thread would keep sleeping after the test
    that started it had finished, and the cost would land on whichever test ran
    next.
    """
    await asyncio.sleep(_LOOKUP_LONGER_THAN_ANY_BUDGET_SECONDS)
    return list(_DUPLICATED_ANSWERS)


@pytest.mark.asyncio
async def test_a_lookup_that_does_not_answer_is_abandoned_within_the_bound(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The wait for a name is bounded by a number this deployment chose.

    Before the bound existed the ceiling was not infinity, and saying so is the
    honest version of the claim: ``getaddrinfo`` is bounded by the operating
    system resolver's own budget, ``timeout`` multiplied by ``attempts``
    multiplied by the number of nameservers in ``resolv.conf``, which is tens of
    seconds on an ordinary box. The defect was never that the wait was unbounded.
    It was that the bound belonged to a file this deployment does not write, is
    not visible from here, and differs between the container this runs in and the
    laptop it was written on -- while the thing being rented for the duration is
    one of fifteen database connections.

    Asserted on elapsed monotonic time rather than on the stub having been
    cancelled, because elapsed time is the property a caller experiences and the
    only one that stays true if the bound is later moved somewhere else.

    Bounded where the lookup is issued rather than at either call site, so that
    a future caller inherits it instead of having to remember it -- which is the
    same reasoning, one layer down, as the seam that frees the connection.
    """
    monkeypatch.setattr(creek_vault_url_resolution, "LOOKUP_BUDGET_SECONDS", _SHRUNK_BUDGET_SECONDS)
    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", _answering_far_too_late)

    started = time.monotonic()
    with pytest.raises(TimeoutError):
        await resolve_host_addresses(_VAULT_HOST)
    elapsed = time.monotonic() - started

    assert elapsed < _GENEROUS_ELAPSED_CEILING_SECONDS, f"the lookup ran for {elapsed:.3f}s"
