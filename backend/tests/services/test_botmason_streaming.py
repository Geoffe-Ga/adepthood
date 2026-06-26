"""Offline unit tests for the BotMason provider streaming paths.

The real ``_stream_openai`` / ``_stream_anthropic`` functions previously carried
``# pragma: no cover - exercised via live integration`` — the paths that actually
serve BYOK chat shipped untested. These tests drive them with a fully mocked SDK
(no network, no key) and assert exact chunk order, accumulation, usage parsing,
and the terminal ``LLMResponse`` payload.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterable

import pytest

from services import botmason
from services.botmason import (
    LLMResponse,
    _extract_openai_delta_text,
    _first_choice_delta_content,
    _get_model,
    _stream_anthropic,
    _stream_openai,
)

_OPENAI_KEY = "sk-test-streaming"  # pragma: allowlist secret
_ANTHROPIC_KEY = "sk-ant-test-streaming"  # pragma: allowlist secret


class _AsyncIter:
    """Wrap a finite iterable as an async iterator (a fake provider stream)."""

    def __init__(self, items: Iterable[object]) -> None:
        self._items = list(items)

    def __aiter__(self) -> _AsyncIter:
        self._it = iter(self._items)
        return self

    async def __anext__(self) -> object:
        try:
            return next(self._it)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


# --- OpenAI fakes ----------------------------------------------------------


class _Delta:
    def __init__(self, content: object) -> None:
        self.content = content


class _Choice:
    def __init__(self, content: object) -> None:
        self.delta = _Delta(content)


class _OpenAIEvent:
    """A streamed chat-completion chunk; ``choices=[]`` is the usage-only tail."""

    def __init__(self, content: object | None = None, usage: object = None) -> None:
        self.choices = [_Choice(content)] if usage is None else []
        self.usage = usage


class _OpenAIUsage:
    def __init__(self, prompt_tokens: int, completion_tokens: int) -> None:
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens


def _fake_openai_module(events: list[_OpenAIEvent]) -> object:
    """Build a stand-in ``openai`` module whose client streams ``events``."""

    class _Completions:
        async def create(self, **_kwargs: object) -> _AsyncIter:
            return _AsyncIter(events)

    class _Chat:
        completions = _Completions()

    class _AsyncOpenAI:
        def __init__(self, **_kwargs: object) -> None:
            self.chat = _Chat()

    class _Module:
        AsyncOpenAI = _AsyncOpenAI

    return _Module()


# --- Anthropic fakes -------------------------------------------------------


class _AnthropicUsage:
    def __init__(self, input_tokens: int, output_tokens: int) -> None:
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class _FinalMessage:
    def __init__(self, usage: object) -> None:
        self.usage = usage


class _AnthropicStream:
    def __init__(self, texts: list[str], final: _FinalMessage) -> None:
        self.text_stream = _AsyncIter(texts)
        self._final = final

    async def __aenter__(self) -> _AnthropicStream:
        return self

    async def __aexit__(self, *_exc: object) -> bool:
        return False

    async def get_final_message(self) -> _FinalMessage:
        return self._final


def _fake_anthropic_module(texts: list[str], final: _FinalMessage) -> object:
    class _Messages:
        def stream(self, **_kwargs: object) -> _AnthropicStream:
            return _AnthropicStream(texts, final)

    class _AsyncAnthropic:
        def __init__(self, **_kwargs: object) -> None:
            self.messages = _Messages()

    class _Module:
        AsyncAnthropic = _AsyncAnthropic

    return _Module()


async def _collect(
    stream: AsyncIterator[tuple[str, LLMResponse | None]],
) -> list[tuple[str, object]]:
    return [item async for item in stream]


# --- OpenAI streaming ------------------------------------------------------


@pytest.mark.asyncio
async def test_stream_openai_yields_deltas_and_terminal_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Each delta is yielded in order, accumulated, and the tail carries usage."""
    events = [
        _OpenAIEvent("Hello"),
        _OpenAIEvent(" world"),
        _OpenAIEvent(None),  # exercises the _extract_openai_delta_text skip branch
        _OpenAIEvent(usage=_OpenAIUsage(prompt_tokens=11, completion_tokens=7)),
    ]
    monkeypatch.setattr(botmason, "_import_optional", lambda *_a: _fake_openai_module(events))

    chunks = await _collect(_stream_openai("hi", [], "sys", _OPENAI_KEY))

    # Two text deltas (None skipped), then the terminal ("", LLMResponse) yield.
    assert [text for text, _ in chunks[:-1]] == ["Hello", " world"]
    assert all(payload is None for _, payload in chunks[:-1])
    tail_text, final = chunks[-1]
    assert tail_text == ""
    assert isinstance(final, LLMResponse)
    assert final.text == "Hello world"
    assert final.provider == "openai"
    assert final.model == _get_model("openai")
    assert final.prompt_tokens == 11
    assert final.completion_tokens == 7


# --- Anthropic streaming ---------------------------------------------------


@pytest.mark.asyncio
async def test_stream_anthropic_yields_text_and_maps_usage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Text deltas stream (empties filtered) and final usage maps to token counts."""
    final = _FinalMessage(_AnthropicUsage(input_tokens=13, output_tokens=5))
    module = _fake_anthropic_module(["Hi", "", " there"], final)
    monkeypatch.setattr(botmason, "_import_optional", lambda *_a: module)

    chunks = await _collect(_stream_anthropic("hi", [], "sys", _ANTHROPIC_KEY))

    # The empty-string delta is filtered by the ``if text:`` guard.
    assert [text for text, _ in chunks[:-1]] == ["Hi", " there"]
    tail_text, result = chunks[-1]
    assert tail_text == ""
    assert isinstance(result, LLMResponse)
    assert result.text == "Hi there"
    assert result.provider == "anthropic"
    assert result.model == _get_model("anthropic")
    assert result.prompt_tokens == 13
    assert result.completion_tokens == 5


# --- Delta helpers ---------------------------------------------------------


def test_first_choice_delta_content_handles_missing_pieces() -> None:
    """Empty choices, a missing delta, and a present value all resolve correctly."""
    assert _first_choice_delta_content(_OpenAIEvent(usage=object())) is None  # no choices
    assert _first_choice_delta_content(_OpenAIEvent("x")) == "x"

    class _NoDelta:
        choices = (object(),)  # choices[0] has no ``delta`` attribute

    assert _first_choice_delta_content(_NoDelta()) is None


def test_extract_openai_delta_text_filters_non_strings_and_empties() -> None:
    """Only a non-empty string content is returned; everything else is ``None``."""
    assert _extract_openai_delta_text(_OpenAIEvent("hi")) == "hi"
    assert _extract_openai_delta_text(_OpenAIEvent("")) is None
    assert _extract_openai_delta_text(_OpenAIEvent(None)) is None
    assert _extract_openai_delta_text(_OpenAIEvent(123)) is None
