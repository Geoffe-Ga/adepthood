"""Every provider client a call builds is closed before the call returns.

``_call_openai`` and ``_call_anthropic`` build a fresh SDK client per call, and
until this suite existed they never closed it. Each one left a pooled,
kept-alive socket behind, owned by nothing but the garbage collector. When the
collector later finalized one, asyncio's ``_SelectorTransport.__del__`` closed
the raw socket without unregistering it from the event loop, so the next socket
to reuse that file descriptor could wait on a readiness event that never came:
the next provider dial hung until the SDK's 30 s timeout. A resonance pass
dials twice (reflection, then completion detection), so the second dial was the
one that stalled -- intermittently, because it depended on when the collector
ran. The browser lane saw it as the own-key resonance pass going unanswered for
25 s; production would have seen a writer's pass take 30 s and come back 502.

The fix is ownership, not timing: the call that opens a client closes it, on
success and on failure alike. These tests drive the real SDK clients through a
mock transport and assert the HTTP client each one was built on is closed when
the call is over -- a property that is deterministic, unlike the hang it
prevents.
"""

from __future__ import annotations

from typing import Any

import pytest

from services import botmason
from services.botmason import _MAX_RETRIES, LLMProviderError, generate_response
from tests.provider_transport import armed_key, use_anthropic, use_openai

_HTTP_OK = 200
#: Not retryable, so a failing call builds exactly one client and gives up.
_HTTP_BAD_REQUEST = 400
#: Retryable, so a failing call spends its whole retry budget on one client.
_HTTP_SERVICE_UNAVAILABLE = 503

_OPENAI_COMPLETION: dict[str, Any] = {
    "id": "chatcmpl-lifecycle",
    "object": "chat.completion",
    "created": 0,
    "model": "gpt-4o-mini",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "a reply"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
}

_ANTHROPIC_MESSAGE: dict[str, Any] = {
    "id": "msg_lifecycle",
    "type": "message",
    "role": "assistant",
    "model": "claude-sonnet-5",
    "content": [{"type": "text", "text": "a reply"}],
    "stop_reason": "end_turn",
    "stop_sequence": None,
    "usage": {"input_tokens": 1, "output_tokens": 1},
}

_OPENAI_REFUSAL: dict[str, Any] = {
    "error": {
        "message": "Invalid request.",
        "type": "invalid_request_error",
        "param": None,
        "code": None,
    }
}

_ANTHROPIC_REFUSAL: dict[str, Any] = {
    "type": "error",
    "error": {"type": "invalid_request_error", "message": "Invalid request."},
}


@pytest.fixture
def _instant_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    """Spend no wall-clock on the retry layer's backoff."""

    async def _no_sleep(delay: float, *args: object, **kwargs: object) -> None:
        del delay, args, kwargs

    monkeypatch.setattr(botmason.asyncio, "sleep", _no_sleep)


class TestOpenAIClientIsClosed:
    """The OpenAI client a call builds does not outlive the call."""

    @pytest.mark.asyncio
    async def test_closed_after_a_successful_call(self, monkeypatch: pytest.MonkeyPatch) -> None:
        stub = use_openai(monkeypatch, _HTTP_OK, _OPENAI_COMPLETION)

        result = await generate_response("hi", [], api_key=armed_key())

        assert result.text == "a reply"
        assert len(stub.http_clients) == 1
        assert stub.http_clients[0].is_closed

    @pytest.mark.asyncio
    async def test_closed_after_a_refused_call(self, monkeypatch: pytest.MonkeyPatch) -> None:
        stub = use_openai(monkeypatch, _HTTP_BAD_REQUEST, _OPENAI_REFUSAL)

        with pytest.raises(LLMProviderError):
            await generate_response("hi", [], api_key=armed_key())

        assert stub.request_count == 1
        assert len(stub.http_clients) == 1
        assert stub.http_clients[0].is_closed

    @pytest.mark.asyncio
    @pytest.mark.usefixtures("_instant_backoff")
    async def test_one_client_serves_every_retry_and_is_closed_once_done(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Retries reuse the call's client; it is closed only when the call ends."""
        stub = use_openai(monkeypatch, _HTTP_SERVICE_UNAVAILABLE, {})

        with pytest.raises(LLMProviderError):
            await generate_response("hi", [], api_key=armed_key())

        assert stub.request_count == _MAX_RETRIES + 1
        assert len(stub.http_clients) == 1
        assert stub.http_clients[0].is_closed


class TestAnthropicClientIsClosed:
    """The Anthropic client a call builds does not outlive the call."""

    @pytest.mark.asyncio
    async def test_closed_after_a_successful_call(self, monkeypatch: pytest.MonkeyPatch) -> None:
        stub = use_anthropic(monkeypatch, _HTTP_OK, _ANTHROPIC_MESSAGE)

        result = await generate_response("hi", [], api_key=armed_key())

        assert result.text == "a reply"
        assert len(stub.http_clients) == 1
        assert stub.http_clients[0].is_closed

    @pytest.mark.asyncio
    async def test_closed_after_a_refused_call(self, monkeypatch: pytest.MonkeyPatch) -> None:
        stub = use_anthropic(monkeypatch, _HTTP_BAD_REQUEST, _ANTHROPIC_REFUSAL)

        with pytest.raises(LLMProviderError):
            await generate_response("hi", [], api_key=armed_key())

        assert stub.request_count == 1
        assert len(stub.http_clients) == 1
        assert stub.http_clients[0].is_closed
