"""Server-Sent Events orchestration for the BotMason streaming endpoint.

The router owns HTTP framing and response construction; this service owns the
mechanics of draining the LLM provider stream, buffering chunks, and shaping
the ``chunk``/``complete``/``error`` SSE events.  Keeping the two concerns
separate means the router stays well under 150 lines of pure HTTP handling
and the stream machinery can be unit-tested without spinning up a
``TestClient``.

The module imports :mod:`services.botmason` (not individual names) so tests
can ``patch.object(services.botmason, "generate_response_stream", ...)``
and this module will see the patched reference at call time.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from schemas.botmason import ChatResponse
from services import botmason as _botmason
from services.botmason import LLMResponse, generate_response
from services.journal import (
    load_recent_conversation,
    persist_bot_reply,
    persist_user_message,
)
from services.usage import get_monthly_cap
from services.wallet import SpendResult, get_user_fresh, preflight_deduction, require_user_fresh

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CollectedStream:
    """Buffered view over a completed provider stream.

    The provider iterator must be drained inside a ``try`` so we can convert
    any mid-stream exception into a single SSE ``error`` event.  That forces
    us to buffer the chunks and only yield them once the stream finished
    cleanly.  Latency in the happy path is still bounded by the provider's
    first-token latency because the buffer is consumed immediately after
    the stream closes.
    """

    chunks: list[bytes]
    response: LLMResponse


def sse_event(event: str, data: dict[str, Any]) -> bytes:
    """Encode a single named Server-Sent Event.

    Each event follows the spec's ``event:``/``data:``/blank-line framing so
    any standards-compliant client (EventSource or custom ``fetch`` reader)
    can parse the stream without provider-specific shims.  ``data`` is
    JSON-encoded on a single line because multi-line ``data:`` fields would
    require extra framing on both ends for no gain.
    """
    payload = json.dumps(data, separators=(",", ":"))
    return f"event: {event}\ndata: {payload}\n\n".encode()


async def collect_provider_stream(
    user_message: str,
    conversation_history: list[dict[str, str]],
    api_key: str | None,
) -> CollectedStream:
    """Drain the provider stream, returning SSE-framed chunks plus the final response.

    Runs inside the caller's ``try``/``except`` so any provider failure
    (timeout, network error, SDK exception) can be translated to a single
    SSE ``error`` event.  Returning only after the stream closes keeps the
    commit / rollback decision centralised.
    """
    final_response: LLMResponse | None = None
    framed_chunks: list[bytes] = []
    async for chunk_text, final in _botmason.generate_response_stream(
        user_message, conversation_history, api_key=api_key
    ):
        if chunk_text:
            framed_chunks.append(sse_event("chunk", {"text": chunk_text}))
        if final is not None:
            final_response = final
    if final_response is None:  # pragma: no cover - defensive; providers always yield final
        msg = "provider stream ended without final response"
        raise RuntimeError(msg)
    return CollectedStream(chunks=framed_chunks, response=final_response)


async def handle_chat_request(
    session: AsyncSession,
    user_id: int,
    message: str,
    api_key: str | None,
) -> ChatResponse:
    """Execute a full non-streaming BotMason exchange and return the response.

    Encapsulates the wallet deduction, journal writes, LLM call, and commit
    so the router layer stays a thin dispatch.  Any exception raised here
    (e.g. ``402 insufficient_offerings`` from :func:`preflight_deduction`)
    surfaces to FastAPI's normal error path.

    Both the user message and bot reply are persisted only after the LLM call
    succeeds, preventing orphaned user messages (BUG-JOURNAL-015).  History
    is loaded *before* the user message is staged so the user's new text
    appears in the LLM prompt via ``generate_response``'s ``user_message``
    parameter, not duplicated from DB.
    """
    spent = await preflight_deduction(session, user_id)
    remaining_messages = max(get_monthly_cap() - spent.monthly_used, 0)

    # Load history BEFORE staging the user message so the DB query doesn't
    # include the unsaved message (it is passed directly to the LLM).
    history = await load_recent_conversation(session, user_id)

    llm_response = await generate_response(message, history, api_key=api_key)

    # Persist both messages together after LLM success (BUG-JOURNAL-015).
    await persist_user_message(session, user_id, message)
    bot_entry = await persist_bot_reply(session, user_id, llm_response)
    await session.commit()
    await session.refresh(bot_entry)

    user_after = await require_user_fresh(session, user_id)
    return ChatResponse(
        response=llm_response.text,
        remaining_balance=spent.offering_balance,
        remaining_messages=remaining_messages,
        monthly_reset_date=user_after.monthly_reset_date,
        bot_entry_id=bot_entry.id,
    )


@dataclass(frozen=True)
class PreflightedRequest:
    """Pre-flight context for a streaming chat — wallet and message in one bundle.

    The router does the pre-flight wallet deduction synchronously (so HTTP
    errors fire before the SSE stream opens) and hands the result to
    :func:`stream_bot_response` inside this DTO.  Keeping the three
    wallet-state fields together makes the generator's signature small and
    lets future fields (e.g. a correlation ID) ride along without touching
    every caller.
    """

    message: str
    api_key: str | None
    spent: SpendResult
    remaining_messages: int


async def stream_bot_response(
    session: AsyncSession,
    user_id: int,
    context: PreflightedRequest,
) -> AsyncIterator[bytes]:
    """Yield SSE events for a streaming BotMason exchange.

    Pre-flight (auth, wallet deduction, key resolution) is the caller's
    responsibility so HTTP errors fire *before* the stream opens.  Once
    invoked, this generator loads conversation history, calls the LLM, and
    only persists both messages after the stream succeeds.

    On provider failure the savepoint is rolled back so no orphan user
    message is committed (BUG-JOURNAL-015).  A descriptive error event
    is emitted so the client can show a "failed" bot placeholder with a
    retry affordance (BUG-JOURNAL-016).
    """
    # Load history before staging anything so the user's new text is only
    # sent via the ``user_message`` parameter, not duplicated from DB.
    history = await load_recent_conversation(session, user_id)
    try:
        collected = await collect_provider_stream(context.message, history, context.api_key)
    except Exception:
        # BUG-JOURNAL-009: log exception context so ops can debug production outages.
        logger.exception("Stream provider error for user_id=%s", user_id)
        # Roll back the wallet deduction so the user isn't charged for a
        # failed request.  No user message was staged so there's nothing
        # to orphan (BUG-JOURNAL-015).
        await session.rollback()
        yield sse_event("error", {"status": 502, "detail": "llm_provider_error"})
        return

    # Persist both messages together only after the stream completed
    # successfully (BUG-JOURNAL-015).
    await persist_user_message(session, user_id, context.message)

    for chunk in collected.chunks:
        yield chunk
    yield await finalise_stream_commit(
        session=session,
        current_user=user_id,
        final_response=collected.response,
        new_balance=context.spent.offering_balance,
        remaining_messages=context.remaining_messages,
    )


async def finalise_stream_commit(
    *,
    session: AsyncSession,
    current_user: int,
    final_response: LLMResponse,
    new_balance: int,
    remaining_messages: int,
) -> bytes:
    """Persist the bot entry + usage log and encode the terminal SSE event.

    Split out so the main streaming generator stays linear and so this commit
    path is easy to unit-test in isolation.  The user row is re-read after
    commit to surface the freshly-advanced ``monthly_reset_date`` without a
    second round-trip from the client.
    """
    bot_entry = await persist_bot_reply(session, current_user, final_response)
    await session.commit()
    await session.refresh(bot_entry)

    user_after = await get_user_fresh(session, current_user)
    if user_after is None:  # pragma: no cover - defensive; user authenticated moments ago
        msg = "user_not_found"
        raise RuntimeError(msg)

    return sse_event(
        "complete",
        {
            "response": final_response.text,
            "remaining_balance": new_balance,
            "remaining_messages": remaining_messages,
            "monthly_reset_date": user_after.monthly_reset_date.isoformat(),
            "bot_entry_id": bot_entry.id,
        },
    )
