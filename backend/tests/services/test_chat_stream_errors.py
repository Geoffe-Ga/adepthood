"""chat_stream narrows its broad excepts (audit §5.3).

A provider ``RuntimeError`` still degrades gracefully (re-raised on the
non-stream path so the route can map it; a 502 SSE event on the stream path),
while a non-provider exception (a programmer bug) propagates instead of being
swallowed or masked as a benign provider failure.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from models.user import User
from services import botmason, chat_stream
from services.chat_stream import PreflightedRequest, handle_chat_request, stream_bot_response
from services.wallet import SpendResult


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


@pytest.mark.asyncio
async def test_non_stream_provider_runtimeerror_propagates(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A provider RuntimeError is rolled back and re-raised (graceful degrade)."""
    user_id = await _make_user(db_session)

    async def _raise(*_args: object, **_kwargs: object) -> object:
        raise RuntimeError("provider down")

    monkeypatch.setattr(chat_stream, "generate_response", _raise)
    with pytest.raises(RuntimeError):
        await handle_chat_request(db_session, user_id, "hello", None)


@pytest.mark.asyncio
async def test_non_stream_bug_propagates(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A non-provider error (programmer bug) is NOT caught — it surfaces."""
    user_id = await _make_user(db_session)

    async def _bug(*_args: object, **_kwargs: object) -> object:
        raise ValueError("oops, a real bug")

    monkeypatch.setattr(chat_stream, "generate_response", _bug)
    with pytest.raises(ValueError, match="real bug"):
        await handle_chat_request(db_session, user_id, "hello", None)


@pytest.mark.asyncio
async def test_stream_provider_runtimeerror_yields_502(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A provider RuntimeError mid-stream degrades to a 502 SSE event."""
    user_id = await _make_user(db_session)

    async def _boom(*_args: object, **_kwargs: object) -> AsyncIterator[object]:
        raise RuntimeError("provider down")
        yield  # unreachable; only present so this is an async generator

    monkeypatch.setattr(botmason, "generate_response_stream", _boom)
    events = [event async for event in stream_bot_response(db_session, user_id, _context())]

    blob = b"".join(events)
    assert b"llm_provider_error" in blob
    assert b"502" in blob


@pytest.mark.asyncio
async def test_stream_bug_propagates(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A non-provider error mid-stream propagates instead of becoming a 502."""
    user_id = await _make_user(db_session)

    async def _bug(*_args: object, **_kwargs: object) -> AsyncIterator[object]:
        raise ValueError("oops, a real bug")
        yield  # unreachable; only present so this is an async generator

    monkeypatch.setattr(botmason, "generate_response_stream", _bug)
    with pytest.raises(ValueError, match="real bug"):
        async for _event in stream_bot_response(db_session, user_id, _context()):
            pass
