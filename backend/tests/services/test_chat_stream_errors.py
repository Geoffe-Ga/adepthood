"""chat_stream narrows its broad excepts (audit §5.3).

``services.botmason`` normalises every provider/SDK/config failure to
``LLMProviderError``; chat_stream catches only that, so provider failures still
degrade gracefully (rollback + re-raise on the non-stream path, a 502 SSE event
on the stream path) while any other exception — including a bare ``RuntimeError``
bug — propagates instead of being swallowed or masked as provider degradation.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from models.user import User
from services import botmason, chat_stream
from services.botmason import LLMProviderError
from services.chat_stream import PreflightedRequest, handle_chat_request, stream_bot_response
from services.wallet import SpendResult


class _FakeSDKError(Exception):
    """Stand-in for a provider SDK exception (e.g. ``openai.APIConnectionError``)."""


# A BYOK-shaped key whose ``sk-`` prefix routes to the OpenAI provider path.
_BYOK_KEY = "sk-test"  # pragma: allowlist secret


async def _make_user(session: AsyncSession, email: str = "chat@example.com") -> int:
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.commit()
    await session.refresh(user)
    assert user.id is not None
    return user.id


def _context(message: str = "hi") -> PreflightedRequest:
    # ``spent`` / ``remaining_messages`` are only read on the success path, which
    # these error tests never reach; the stream fails at the first provider call.
    return PreflightedRequest(
        message=message,
        api_key=None,
        spent=SpendResult(monthly_used=1, offering_balance=0),
        remaining_messages=10,
    )


# ── Non-stream path (handle_chat_request) ───────────────────────────────────


@pytest.mark.asyncio
async def test_non_stream_provider_error_rolls_back_and_reraises(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A provider failure rolls back the wallet deduction and re-raises (BUG-BM-013)."""
    user_id = await _make_user(db_session)
    rollback_spy = AsyncMock(wraps=db_session.rollback)
    monkeypatch.setattr(db_session, "rollback", rollback_spy)

    async def _raise(*_args: object, **_kwargs: object) -> object:
        raise LLMProviderError("provider down")

    monkeypatch.setattr(chat_stream, "generate_response", _raise)
    with pytest.raises(LLMProviderError):
        await handle_chat_request(db_session, user_id, "hello", None)
    assert rollback_spy.await_count >= 1  # the deduction was undone


@pytest.mark.asyncio
@pytest.mark.parametrize("bug", [ValueError("real bug"), RuntimeError("internal bug")])
async def test_non_stream_bug_propagates(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch, bug: Exception
) -> None:
    """A non-provider error (incl. a bare RuntimeError) is NOT masked — it surfaces."""
    user_id = await _make_user(db_session)

    async def _raise(*_args: object, **_kwargs: object) -> object:
        raise bug

    monkeypatch.setattr(chat_stream, "generate_response", _raise)
    with pytest.raises(type(bug)):
        await handle_chat_request(db_session, user_id, "hello", None)


# ── Stream path (stream_bot_response) ───────────────────────────────────────


@pytest.mark.asyncio
async def test_stream_provider_error_yields_502(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A provider failure mid-stream degrades to a 502 SSE event."""
    user_id = await _make_user(db_session)

    async def _boom(*_args: object, **_kwargs: object) -> AsyncIterator[object]:
        raise LLMProviderError("provider down")
        yield  # unreachable; only present so this is an async generator

    monkeypatch.setattr(botmason, "generate_response_stream", _boom)
    blob = b"".join([event async for event in stream_bot_response(db_session, user_id, _context())])

    assert b"llm_provider_error" in blob
    assert b"502" in blob


@pytest.mark.asyncio
@pytest.mark.parametrize("bug", [ValueError("real bug"), RuntimeError("internal bug")])
async def test_stream_bug_propagates(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch, bug: Exception
) -> None:
    """A non-provider error mid-stream propagates instead of becoming a 502."""
    user_id = await _make_user(db_session)

    async def _raise(*_args: object, **_kwargs: object) -> AsyncIterator[object]:
        raise bug
        yield  # unreachable; only present so this is an async generator

    monkeypatch.setattr(botmason, "generate_response_stream", _raise)
    with pytest.raises(type(bug)):
        async for _event in stream_bot_response(db_session, user_id, _context()):
            pass


# ── botmason normalises SDK exceptions to LLMProviderError ───────────────────


@pytest.mark.asyncio
async def test_generate_response_wraps_sdk_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """A raw SDK exception from the provider call surfaces as LLMProviderError."""

    async def _raise(*_args: object, **_kwargs: object) -> object:
        raise _FakeSDKError("connection reset")

    monkeypatch.setattr(botmason, "_call_openai", _raise)
    with pytest.raises(LLMProviderError):
        await botmason.generate_response("hi", [], api_key=_BYOK_KEY)


@pytest.mark.asyncio
async def test_generate_response_stream_wraps_sdk_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """A raw SDK exception from the streamer surfaces as LLMProviderError."""

    async def _raise(*_args: object, **_kwargs: object) -> AsyncIterator[object]:
        raise _FakeSDKError("stream died")
        yield  # unreachable; only present so this is an async generator

    monkeypatch.setattr(botmason, "_stream_openai", _raise)
    with pytest.raises(LLMProviderError):
        async for _event in botmason.generate_response_stream("hi", [], api_key=_BYOK_KEY):
            pass
