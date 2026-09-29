"""Observe the moment a request reaches a privacy serializer, instead of guessing it.

A race test that holds one dial open and asks "did the competing request wait
for it?" has to know the competitor actually *got to* the lock before the dial
is released. A short ``wait_for(shield(task), timeout=...)`` cannot tell that:
it also times out when the competitor is still in authentication, rate limiting
or its first database read, and on a slow runner the dial is then released
before the competitor has queued -- so the product's FIFO lock correctly lets
the holder's *next* critical section go first, and the test fails for a reason
that has nothing to do with the property it states (#2986).

:class:`BarrierArrivals` wraps one :class:`VoiceDraftPrivacySerializer`
instance's ``hold`` and records which labelled request arrived at it. The
arrival is recorded synchronously at the top of ``hold``, and nothing between
there and the in-process ``asyncio.Lock`` enqueuing its waiter suspends, so by
the time a test awaiting :meth:`BarrierArrivals.arrived` resumes,
the labelled request is either holding the lock or already queued on it.

Requests are labelled through a context variable rather than by task identity,
because middleware may run the handler in a child task; a child task copies its
parent's context, so the label follows the request wherever it is served.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Coroutine
from contextlib import asynccontextmanager
from contextvars import ContextVar, copy_context
from typing import TypeVar

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from services.voice_draft_privacy import OnUnavailable, VoiceDraftPrivacySerializer

_T = TypeVar("_T")

_ACTOR: ContextVar[str | None] = ContextVar("barrier_arrival_actor", default=None)


class BarrierArrivals:
    """Record, per labelled request, that it reached one serializer's ``hold``."""

    def __init__(self, serializer: VoiceDraftPrivacySerializer) -> None:
        """Wrap ``serializer.hold``; call :meth:`install` to put the wrapper in place."""
        self._original_hold = serializer.hold
        self._arrived: dict[str, asyncio.Event] = {}

    @classmethod
    def install(
        cls, monkeypatch: pytest.MonkeyPatch, serializer: VoiceDraftPrivacySerializer
    ) -> BarrierArrivals:
        """Replace ``serializer.hold`` for this test with an arrival-recording wrapper."""
        arrivals = cls(serializer)
        monkeypatch.setattr(serializer, "hold", arrivals.hold)
        return arrivals

    def _event(self, actor: str) -> asyncio.Event:
        return self._arrived.setdefault(actor, asyncio.Event())

    def start(self, actor: str, request: Coroutine[object, object, _T]) -> asyncio.Task[_T]:
        """Run ``request`` as a task whose barrier arrivals are recorded as ``actor``."""
        self._event(actor)
        context = copy_context()
        context.run(_ACTOR.set, actor)
        return asyncio.create_task(request, context=context)

    async def arrived(self, actor: str, *, within_seconds: float) -> bool:
        """Whether ``actor`` came to hold, or queue on, the barrier within the bound.

        Answers rather than raises, so the caller can release whatever dial it
        is holding and drain its request tasks before it asserts: an exception
        escaping here would orphan them mid-request and stall fixture teardown.
        """
        try:
            await asyncio.wait_for(self._event(actor).wait(), timeout=within_seconds)
        except TimeoutError:
            return False
        return True

    @asynccontextmanager
    async def hold(
        self,
        session: AsyncSession,
        key: int,
        *,
        on_unavailable: OnUnavailable = "refuse",
        cross_worker: bool = True,
    ) -> AsyncIterator[None]:
        """Record the arrival, then take the real barrier with no suspension in between."""
        actor = _ACTOR.get()
        if actor is not None:
            self._event(actor).set()
        async with self._original_hold(
            session, key, on_unavailable=on_unavailable, cross_worker=cross_worker
        ):
            yield
