"""Each installed SDK's own transport stack stays inside the normalizing catch.

:data:`services.botmason._PROVIDER_ERROR_TYPES` and
:data:`services.botmason._TRANSIENT_NETWORK_TYPES` name the raw transport base
classes of *both* httpx distributions the lock carries, because ``httpx2`` is a
separate distribution from ``httpx`` and shares no base class with it. Nothing
pinned that membership until this module existed, and the failure mode it
guards is the one that leaves no diagnostic behind: an SDK that moves to a
third distribution keeps compiling, keeps type-checking, and the ``except``
tuple simply stops covering its transport -- a silent narrowing.

Two things are pinned here, and both are read out of the running SDKs rather
than asserted from memory:

* **Which stack each SDK is on** is taken from that SDK's public
  ``DefaultAsyncHttpxClient``, whose MRO is the SDK's own answer to the
  question. If a major bump moves an SDK onto a different distribution, that
  fact lands here first.
* **That the stack's errors are covered** is proved by driving a real request
  through that stack's mock transport, letting it raise its own typed error,
  and asserting the exception object the SDK actually produced is matched by
  the tuples. The expected type is never hand-built, so this cannot degenerate
  into a hardcoded tuple compared against a hardcoded tuple.

One honest limit, worth recording because it bounds what these tests prove:
both SDKs wrap transport failures in their own ``APIConnectionError`` before
this layer sees them, so the raw ``httpx``/``httpx2`` entries are
defence-in-depth for an escape past that wrapping (a client built with an
injected ``http_client`` failing before the SDK's own try, say) rather than the
path a plain provider outage takes. These tests therefore assert coverage of
the raw exception the transport really raised, not that it reaches the catch
unwrapped -- which it does not, and the assertions on ``__cause__`` say so.
"""

from __future__ import annotations

import importlib
from typing import TYPE_CHECKING

import anthropic
import httpx
import httpx2
import openai
import pytest

from services import botmason
from services.botmason import (
    _MAX_RETRIES,
    _PROVIDER_ERROR_TYPES,
    _TRANSIENT_NETWORK_TYPES,
    LLMProviderError,
    generate_response,
)
from tests.provider_transport import use_anthropic, use_openai

if TYPE_CHECKING:
    from types import ModuleType

#: The stub raises before it can answer, so its status is never read. Named
#: rather than inlined so nobody reads meaning into the number.
_UNREACHED_STATUS = 503

#: Every failure driven here is a transport error, which ``_is_retryable``
#: treats as transient, so the retry loop spends its whole budget rather than
#: giving up after one call. Asserting that exact count is what distinguishes a
#: covered transport error from one the catch matched but the retry policy had
#: stopped recognising -- a bare "at least one request" passes either way. The
#: budget itself is derived rather than duplicated, and is pinned where it
#: belongs, in the retry suite; what this file owns is that these two stacks
#: reach it at all.
_EXPECTED_ATTEMPTS = _MAX_RETRIES + 1


def _transport_stack(default_client: type, sdk_package: str) -> ModuleType:
    """Return the httpx distribution an SDK builds its own default client on.

    ``DefaultAsyncHttpxClient`` is exported from both SDKs' ``__all__`` and
    subclasses the async client class of whichever distribution the SDK is
    typed against, so the first base outside the SDK's own package names that
    distribution. Reading it this way means an SDK that changes transports
    changes this answer without anyone editing a test.
    """
    for base in default_client.__mro__:
        root = base.__module__.partition(".")[0]
        if root not in {sdk_package, "builtins"}:
            return importlib.import_module(root)
    msg = f"{sdk_package}'s default async client has no transport base: {default_client.__mro__}"
    raise AssertionError(msg)


def _raw_transport_cause(exc: BaseException) -> BaseException:
    """Return the deepest cause in ``exc``'s chain -- what the transport raised.

    The SDK's own wrapper sits between this layer's ``LLMProviderError`` and the
    transport exception, so walking to the end of the chain is what reaches the
    object the transport stack actually constructed.
    """
    cause: BaseException = exc
    while cause.__cause__ is not None:
        cause = cause.__cause__
    return cause


@pytest.fixture
def _instant_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    """Spend no wall-clock on this layer's backoff, or either SDK's.

    A dropped connection is retryable, so these tests take the full retry
    budget; patching the module-global ``asyncio.sleep`` keeps that from
    costing three real seconds apiece.
    """

    async def _no_sleep(delay: float, *args: object, **kwargs: object) -> None:
        del delay, args, kwargs

    monkeypatch.setattr(botmason.asyncio, "sleep", _no_sleep)


class TestEachSdkIsOnTheStackTheSuiteDrives:
    """The mock transports must be built from the distribution the SDK really uses.

    ``tests.provider_transport`` hands each SDK a client of one specific
    distribution. Anthropic rejects a foreign one outright at construction;
    OpenAI 3.x still accepts a legacy ``httpx`` client, so for OpenAI nothing
    but this check would notice a divergence. Either way, the moment an SDK
    moves distributions these assertions are the first thing to say so.
    """

    def test_openai_is_typed_against_httpx2(self) -> None:
        """OpenAI 3.x moved to httpx2, which is why the lock carries two stacks."""
        assert _transport_stack(openai.DefaultAsyncHttpxClient, "openai") is httpx2

    def test_anthropic_is_typed_against_httpx(self) -> None:
        """Anthropic is still on httpx at the current pin; a major bump moves this."""
        assert _transport_stack(anthropic.DefaultAsyncHttpxClient, "anthropic") is httpx


@pytest.mark.usefixtures("_instant_backoff")
class TestARealTransportFailureIsCoveredByTheCatch:
    """Drive each stack until it raises its own error, then check the tuples cover it."""

    @pytest.mark.asyncio
    async def test_openais_httpx2_failure_is_covered_and_normalized(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A dropped socket on OpenAI's stack is an ``httpx2`` error, not an ``httpx`` one.

        ``httpx2.ConnectError`` is neither an ``OSError`` nor an
        ``httpx.HTTPError``, so only the ``httpx2`` entries can match it. Drop
        either one and this test is the thing that notices.
        """
        stub = use_openai(
            monkeypatch,
            _UNREACHED_STATUS,
            raises=httpx2.ConnectError("connection reset by peer"),
        )
        with pytest.raises(LLMProviderError) as excinfo:
            await generate_response("hi", [])

        assert stub.request_count == _EXPECTED_ATTEMPTS
        assert isinstance(excinfo.value.__cause__, openai.APIConnectionError)
        assert isinstance(excinfo.value.__cause__, _PROVIDER_ERROR_TYPES)

        raw = _raw_transport_cause(excinfo.value)
        assert isinstance(raw, httpx2.HTTPError)
        assert isinstance(raw, _PROVIDER_ERROR_TYPES)
        assert isinstance(raw, _TRANSIENT_NETWORK_TYPES)

    @pytest.mark.asyncio
    async def test_anthropics_httpx_failure_is_covered_and_normalized(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The other SDK is on the other distribution, so it needs its own proof."""
        stub = use_anthropic(
            monkeypatch,
            _UNREACHED_STATUS,
            raises=httpx.ConnectError("connection reset by peer"),
        )
        with pytest.raises(LLMProviderError) as excinfo:
            await generate_response("hi", [])

        assert stub.request_count == _EXPECTED_ATTEMPTS
        assert isinstance(excinfo.value.__cause__, anthropic.APIConnectionError)
        assert isinstance(excinfo.value.__cause__, _PROVIDER_ERROR_TYPES)

        raw = _raw_transport_cause(excinfo.value)
        assert isinstance(raw, httpx.HTTPError)
        assert isinstance(raw, _PROVIDER_ERROR_TYPES)
        assert isinstance(raw, _TRANSIENT_NETWORK_TYPES)

    @pytest.mark.asyncio
    async def test_the_two_stacks_errors_do_not_substitute_for_each_other(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Without this, one entry could look like it covered both providers.

        The whole reason the tuples name two transport base classes rather than
        one is that these hierarchies are disjoint. If they ever converged, a
        single entry would be enough and the second would be dead weight -- so
        pin the disjointness the pair exists for.
        """
        stub = use_openai(
            monkeypatch,
            _UNREACHED_STATUS,
            raises=httpx2.ConnectError("connection reset by peer"),
        )
        with pytest.raises(LLMProviderError) as excinfo:
            await generate_response("hi", [])

        assert stub.request_count == _EXPECTED_ATTEMPTS
        raw = _raw_transport_cause(excinfo.value)
        assert not isinstance(raw, httpx.HTTPError)
        assert not isinstance(raw, OSError)
