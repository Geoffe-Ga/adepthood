"""Unit tests for the retry/backoff subsystem in :mod:`services.botmason`.

BUG-JOURNAL-006 added transient-failure retries for provider calls:
``_is_retryable`` classifies an exception as a network blip or a retryable
HTTP status (429 / 5xx), and ``_retry_on_transient`` wraps a zero-arg async
factory with up to ``_MAX_RETRIES`` retries using exponential backoff.

These tests pin the classification rules in ``_is_retryable`` and the
control flow of ``_retry_on_transient`` -- including the attempt-count
boundary and the exact backoff delays -- without ever sleeping in real
time (``asyncio.sleep`` is patched to an ``AsyncMock``).
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import httpx2
import openai
import pytest

from services import botmason
from services.botmason import (
    _LLM_TIMEOUT_SECONDS,
    _MAX_RETRIES,
    _RETRY_BASE_DELAY,
    ImagePayload,
    _call_openai,
    _is_retryable,
    _retry_on_transient,
)

_RETRYABLE_STATUS_CODES_UNDER_TEST = (429, 500, 502, 503, 504)
_NON_RETRYABLE_STATUS_CODES_UNDER_TEST = (400, 401, 403, 404)
_RETRYABLE_NETWORK_EXCEPTION_TYPES = (OSError, ConnectionError, TimeoutError)


class _FakeStatusCodeError(Exception):
    """Fake provider error carrying a ``status_code`` attribute."""

    def __init__(self, status_code: int) -> None:
        super().__init__("fake provider error")
        self.status_code = status_code


class _FakeStatusError(Exception):
    """Fake provider error carrying only a ``status`` attribute."""

    def __init__(self, status: int) -> None:
        super().__init__("fake provider error")
        self.status = status


class _RetryableProviderError(Exception):
    """A provider error whose status code is in the retryable set."""

    status_code = 503


class _RaisingFactory:
    """Zero-arg async callable that raises the same exception every call."""

    def __init__(self, exc: BaseException) -> None:
        self._exc = exc
        self.call_count = 0

    async def __call__(self) -> object:
        self.call_count += 1
        raise self._exc


class _EventualSuccessFactory:
    """Zero-arg async callable that raises once, then returns a result."""

    def __init__(self, exc: BaseException, result: object) -> None:
        self._exc = exc
        self._result = result
        self.call_count = 0

    async def __call__(self) -> object:
        self.call_count += 1
        if self.call_count == 1:
            raise self._exc
        return self._result


@pytest.fixture
def sleep_mock(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
    """Patch ``asyncio.sleep`` inside the botmason module so tests never sleep."""
    mock = AsyncMock()
    monkeypatch.setattr(botmason.asyncio, "sleep", mock)
    return mock


class TestIsRetryable:
    """``_is_retryable`` classifies transient failures correctly."""

    @pytest.mark.parametrize("status_code", _RETRYABLE_STATUS_CODES_UNDER_TEST)
    def test_retryable_status_code_attribute(self, status_code: int) -> None:
        assert _is_retryable(_FakeStatusCodeError(status_code)) is True

    def test_retryable_status_attribute_spelling(self) -> None:
        """Some SDKs expose ``status`` rather than ``status_code``."""
        assert _is_retryable(_FakeStatusError(503)) is True

    @pytest.mark.parametrize("exc_type", _RETRYABLE_NETWORK_EXCEPTION_TYPES)
    def test_retryable_network_exception_types(self, exc_type: type[Exception]) -> None:
        assert _is_retryable(exc_type("network blip")) is True

    @pytest.mark.parametrize("status_code", _NON_RETRYABLE_STATUS_CODES_UNDER_TEST)
    def test_non_retryable_status_code(self, status_code: int) -> None:
        assert _is_retryable(_FakeStatusCodeError(status_code)) is False

    def test_non_retryable_bare_exception_without_status(self) -> None:
        """An exception with no status attribute at all is never retried."""
        assert _is_retryable(ValueError("not a provider error")) is False


class TestRetryOnTransient:
    """``_retry_on_transient`` retries transient failures with backoff."""

    @pytest.mark.asyncio
    async def test_retryable_error_then_success_returns_result(self, sleep_mock: AsyncMock) -> None:
        sentinel = object()
        factory = _EventualSuccessFactory(_RetryableProviderError(), sentinel)

        result = await _retry_on_transient(factory)

        assert result is sentinel
        assert factory.call_count == 2
        assert sleep_mock.await_count == 1

    @pytest.mark.asyncio
    async def test_non_retryable_error_reraises_immediately(self, sleep_mock: AsyncMock) -> None:
        error = ValueError("not a provider error")
        factory = _RaisingFactory(error)

        with pytest.raises(ValueError, match="not a provider error") as exc_info:
            await _retry_on_transient(factory)

        assert exc_info.value is error
        assert factory.call_count == 1
        sleep_mock.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_persistent_retryable_error_exhausts_retries(self, sleep_mock: AsyncMock) -> None:
        error = _RetryableProviderError()
        factory = _RaisingFactory(error)

        with pytest.raises(_RetryableProviderError) as exc_info:
            await _retry_on_transient(factory)

        assert exc_info.value is error
        assert factory.call_count == _MAX_RETRIES + 1
        assert sleep_mock.await_count == _MAX_RETRIES

    @pytest.mark.asyncio
    async def test_persistent_retryable_error_backoff_delays_double(
        self, sleep_mock: AsyncMock
    ) -> None:
        factory = _RaisingFactory(_RetryableProviderError())

        with pytest.raises(_RetryableProviderError):
            await _retry_on_transient(factory)

        expected_delays = [_RETRY_BASE_DELAY * 2**0, _RETRY_BASE_DELAY * 2**1]
        actual_delays = [call.args[0] for call in sleep_mock.call_args_list]
        assert actual_delays == expected_delays


def _fake_openai_completion(text: str) -> object:
    """Build a bare object shaped like an OpenAI ``ChatCompletion`` for a fake client."""
    message = type("Msg", (), {"content": text})()
    choice = type("Choice", (), {"message": message})()
    usage = type("Usage", (), {"prompt_tokens": 5, "completion_tokens": 3})()
    return type("Completion", (), {"choices": [choice], "usage": usage})()


class TestCallOpenAIRetryWithImages:
    """A vision request retries transient failures exactly like a text-only one."""

    @pytest.mark.asyncio
    async def test_transient_error_then_success_retries_once_with_images(
        self, sleep_mock: AsyncMock, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        success = _fake_openai_completion("described the image")
        create_mock = AsyncMock(side_effect=[_FakeStatusCodeError(503), success])
        constructed_kwargs: dict[str, object] = {}

        class _FakeOpenAIClient:
            def __init__(self, **kwargs: object) -> None:
                constructed_kwargs.update(kwargs)
                completions = type("Completions", (), {"create": staticmethod(create_mock)})()
                self.chat = type("Chat", (), {"completions": completions})()

        monkeypatch.setattr(openai, "AsyncOpenAI", _FakeOpenAIClient)
        image = ImagePayload(data="ZmFrZQ==", media_type="image/png")

        result = await _call_openai(
            "describe this",
            [],
            "SYSTEM PROMPT",
            api_key="sk-test-key",  # pragma: allowlist secret
            images=[image],
        )

        assert result.text == "described the image"
        assert create_mock.await_count == 2
        assert sleep_mock.await_count == 1
        assert constructed_kwargs["timeout"] == _LLM_TIMEOUT_SECONDS

    @pytest.mark.asyncio
    async def test_persistent_transient_error_exhausts_retries_with_images(
        self, sleep_mock: AsyncMock, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        create_mock = AsyncMock(side_effect=_FakeStatusCodeError(503))
        constructed_kwargs: dict[str, object] = {}

        class _FakeOpenAIClient:
            def __init__(self, **kwargs: object) -> None:
                constructed_kwargs.update(kwargs)
                completions = type("Completions", (), {"create": staticmethod(create_mock)})()
                self.chat = type("Chat", (), {"completions": completions})()

        monkeypatch.setattr(openai, "AsyncOpenAI", _FakeOpenAIClient)
        image = ImagePayload(data="ZmFrZQ==", media_type="image/png")

        with pytest.raises(_FakeStatusCodeError):
            await _call_openai(
                "describe this",
                [],
                "SYSTEM PROMPT",
                api_key="sk-test-key",  # pragma: allowlist secret
                images=[image],
            )

        assert create_mock.await_count == _MAX_RETRIES + 1
        assert sleep_mock.await_count == _MAX_RETRIES
        assert constructed_kwargs["timeout"] == _LLM_TIMEOUT_SECONDS


# --- Quota exhaustion: a 429 that no amount of waiting can clear ------------

#: OpenAI's real body for an account whose quota is spent. Built as a genuine
#: ``openai.RateLimitError`` rather than a ``_FakeStatusCodeError`` on purpose:
#: the synthetic fake above carries no body and no ``code``, so every existing
#: 429 case in ``TestIsRetryable`` passes without ever exercising the one
#: attribute that separates an empty account from a busy one. That blind spot
#: is how this shipped.
_OPENAI_QUOTA_ERROR_BODY: dict[str, object] = {
    "message": "You exceeded your current quota, please check your plan and billing details.",
    "type": "insufficient_quota",
    "param": None,
    "code": "insufficient_quota",
}

#: The same status from the same SDK class for the common, genuinely transient
#: case. Retrying this one is correct.
_OPENAI_RATE_LIMIT_ERROR_BODY: dict[str, object] = {
    "message": "Rate limit reached for gpt-4o-mini in organization on requests per min.",
    "type": "requests",
    "param": None,
    "code": "rate_limit_exceeded",
}

_TOO_MANY_REQUESTS = 429
_ONE_ATTEMPT = 1


def _openai_429(body: dict[str, object]) -> openai.RateLimitError:
    """Build the real SDK error OpenAI raises for a 429 carrying ``body``."""
    # ``httpx2`` -- not ``httpx`` -- because openai 3.x is typed against it.
    request = httpx2.Request("POST", "https://api.openai.com/v1/chat/completions")
    response = httpx2.Response(_TOO_MANY_REQUESTS, request=request, json={"error": body})
    return openai.RateLimitError("rate limited", response=response, body=body)


class TestQuotaExhaustionIsNotTransient:
    """A billing state and a congestion state share a status but not a remedy."""

    def test_insufficient_quota_429_is_not_retryable(self) -> None:
        """The machine-readable ``code``, not the status, decides this one."""
        assert _is_retryable(_openai_429(_OPENAI_QUOTA_ERROR_BODY)) is False

    def test_genuine_rate_limit_429_is_still_retryable(self) -> None:
        """The common case is untouched -- a fix that breaks this is a regression."""
        assert _is_retryable(_openai_429(_OPENAI_RATE_LIMIT_ERROR_BODY)) is True

    @pytest.mark.asyncio
    async def test_quota_error_is_attempted_once_with_no_backoff(
        self, sleep_mock: AsyncMock
    ) -> None:
        """One call, zero sleeps: the account is empty and waiting cannot fill it."""
        factory = _RaisingFactory(_openai_429(_OPENAI_QUOTA_ERROR_BODY))

        with pytest.raises(openai.RateLimitError):
            await _retry_on_transient(factory)

        assert factory.call_count == _ONE_ATTEMPT
        sleep_mock.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_genuine_rate_limit_still_exhausts_the_retry_budget(
        self, sleep_mock: AsyncMock
    ) -> None:
        """The regression guard, at the loop rather than the predicate."""
        factory = _RaisingFactory(_openai_429(_OPENAI_RATE_LIMIT_ERROR_BODY))

        with pytest.raises(openai.RateLimitError):
            await _retry_on_transient(factory)

        assert factory.call_count == _MAX_RETRIES + 1
        assert sleep_mock.await_count == _MAX_RETRIES
