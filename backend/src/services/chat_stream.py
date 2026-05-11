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

BUG-BM-007: ``CollectedStream`` (which buffered the entire provider response)
has been replaced with a true pass-through async generator that yields chunks
as they arrive.  This means the client sees the first token almost immediately
rather than waiting for the whole response.

BUG-BM-006: a ``watch_disconnect`` task polls ``request.is_disconnected()``
every 0.25 s and cancels the upstream provider iteration if the client
disappears, stopping billing for a stream the user will never see.

BUG-BM-013: the wallet deduction (staged by ``preflight_deduction``) is in
an uncommitted transaction until ``finalise_stream_commit`` commits it.  Any
failure path that reaches the ``except`` / ``finally`` blocks in
``stream_bot_response`` calls ``session.rollback()`` to undo the deduction —
the user is *never* charged for a turn that produced no persisted response.
This works because the deduction and the stream live in the same SQLAlchemy
session whose transaction has not yet been committed when a failure occurs.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

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

    BUG-BM-013: on LLM failure the session is rolled back so the uncommitted
    wallet deduction is undone — the user is never charged for a failed turn.
    The deduction is staged but not committed before the LLM call; a rollback
    here reverses it atomically.
    """
    spent = await preflight_deduction(session, user_id)
    remaining_messages = max(get_monthly_cap() - spent.monthly_used, 0)

    # Load history BEFORE staging the user message so the DB query doesn't
    # include the unsaved message (it is passed directly to the LLM).
    history = await load_recent_conversation(session, user_id)

    try:
        llm_response = await generate_response(message, history, api_key=api_key)
    except Exception:
        # BUG-BM-013: LLM call failed after wallet deduction — rollback the
        # uncommitted transaction so the user is not charged.  The deduction
        # is staged (UPDATE issued) but not yet committed; a rollback reverses
        # it in a single round-trip without a compensating credit INSERT.
        logger.exception("LLM call failed for user_id=%s; rolling back wallet deduction", user_id)
        try:
            await session.rollback()
        except Exception:
            logger.exception("Rollback failed for user_id=%s", user_id)
        raise

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

    BUG-BM-006: ``request`` is included so the streaming generator can poll
    ``request.is_disconnected()`` to detect when the HTTP client has gone away
    and cancel the upstream LLM call.
    """

    message: str
    api_key: str | None
    spent: SpendResult
    remaining_messages: int
    request: Request | None = None


async def _watch_for_disconnect(
    request: Request,
    target_task: asyncio.Task[object],
    *,
    poll_interval: float = 0.25,
) -> None:
    """Poll ``request.is_disconnected()`` and cancel ``target_task`` on disconnect.

    BUG-BM-006: without a disconnect watcher, the upstream LLM call continues
    until the provider flushes its final token even when the HTTP client has
    gone away.  This watcher fires :meth:`asyncio.Task.cancel` on the
    streaming task so the async-for loop inside it raises
    ``asyncio.CancelledError``, unwinding both the provider connection and the
    DB session in the finally block.

    The loop sleeps *before* the first disconnect check (rather than after)
    so the watcher cannot race a fast-fail provider error: in some ASGI
    test transports ``is_disconnected()`` returns ``True`` immediately
    after the request body is consumed, which would spuriously cancel the
    streaming task before the error path can emit its SSE error event.
    The 250 ms grace period gives the generator time to finish or yield
    its first chunk; production clients don't disconnect that fast after
    sending a request.

    ``poll_interval`` defaults to 0.25 s — a good balance between disconnect
    latency (~250 ms lag) and polling overhead (~4 syscalls per second during
    a typical 5-second stream).
    """
    while True:
        await asyncio.sleep(poll_interval)
        if await request.is_disconnected():
            target_task.cancel()
            return


async def _rollback_quietly(session: AsyncSession, user_id: int, reason: str) -> None:
    """Best-effort rollback: log and swallow secondary failures.

    Extracted so the streaming generator's exception handlers stay flat
    (avoids tripping C901's branch counter twice for the same pattern).
    Calling rollback on an already-rolled-back session is a no-op in
    SQLAlchemy, so the broad ``except`` is genuinely defensive.
    """
    try:
        await session.rollback()
    except Exception:  # pragma: no cover - defensive; rollback is idempotent
        logger.exception("Stream rollback failed for user_id=%s reason=%s", user_id, reason)


def _ensure_final_response(final_response: LLMResponse | None) -> LLMResponse:
    """Narrow ``Optional[LLMResponse]`` to ``LLMResponse`` or raise.

    Splitting the raise into a helper keeps it outside the streaming
    generator's ``try`` block (TRY301 — abstract raises into a callable so
    the try body only contains the operations whose failure we actually
    want to handle).
    """
    if final_response is None:  # pragma: no cover - defensive; providers always yield final
        msg = "provider stream ended without final response"
        raise RuntimeError(msg)
    return final_response


async def stream_bot_response(
    session: AsyncSession,
    user_id: int,
    context: PreflightedRequest,
) -> AsyncIterator[bytes]:
    """Yield SSE events for a streaming BotMason exchange.

    BUG-BM-007: chunks are yielded as they arrive from the provider (true
    pass-through, no buffering).  The old ``CollectedStream`` pattern
    buffered the entire response before emitting a single byte, defeating
    the purpose of streaming and risking unbounded memory usage on long
    completions.

    BUG-BM-006: a ``_watch_for_disconnect`` task polls
    ``context.request.is_disconnected()`` every 0.25 s.  If the client
    disappears, the task cancels the current async task, which propagates as
    ``asyncio.CancelledError`` into the provider for-loop and triggers the
    rollback path.

    BUG-BM-013: the wallet deduction staged by ``preflight_deduction`` is
    NOT committed until ``finalise_stream_commit`` succeeds.  Any failure
    path (provider error, disconnect, unexpected exception) calls
    ``session.rollback()`` to undo the uncommitted deduction so the user is
    never charged for a turn that produced no persisted response.

    Pre-flight (auth, wallet deduction, key resolution) is the caller's
    responsibility so HTTP errors fire *before* the stream opens.
    """
    # Load history before staging anything so the user's new text is only
    # sent via the ``user_message`` parameter, not duplicated from DB.
    history = await load_recent_conversation(session, user_id)

    # BUG-BM-006: spin up the disconnect watcher if we have a request object.
    # The watcher runs as a background task and cancels the current task if
    # the client disconnects.
    current_task = asyncio.current_task()
    watcher: asyncio.Task[None] | None = None
    if context.request is not None and current_task is not None:
        watcher = asyncio.create_task(_watch_for_disconnect(context.request, current_task))

    try:
        final_response: LLMResponse | None = None

        # BUG-BM-007: true pass-through — yield each chunk as it arrives from
        # the provider instead of collecting all chunks first.
        async for chunk_text, final in _botmason.generate_response_stream(
            context.message, history, api_key=context.api_key
        ):
            if chunk_text:
                yield sse_event("chunk", {"text": chunk_text})
            if final is not None:
                final_response = final

        resolved_final = _ensure_final_response(final_response)

        # Stream completed successfully — persist and commit.
        await persist_user_message(session, user_id, context.message)
        complete_event = await finalise_stream_commit(
            session=session,
            current_user=user_id,
            final_response=resolved_final,
            new_balance=context.spent.offering_balance,
            remaining_messages=context.remaining_messages,
        )
        yield complete_event

    except asyncio.CancelledError:
        # Client disconnected (BUG-BM-006): rollback the uncommitted wallet
        # deduction so the user is not charged for the abandoned stream.
        logger.info(
            "stream_cancelled_by_disconnect for user_id=%s; rolling back deduction", user_id
        )
        await _rollback_quietly(session, user_id, "cancelled")
        raise  # Re-raise so Starlette can close the connection cleanly.

    except Exception:
        # BUG-BM-013: BUG-INFRA-011: provider error — rollback the uncommitted
        # wallet deduction so the user is not charged for a failed turn.
        logger.exception("Stream provider error for user_id=%s", user_id)
        await _rollback_quietly(session, user_id, "provider_error")
        yield sse_event("error", {"status": 502, "detail": "llm_provider_error"})

    finally:
        # Cancel the watcher regardless of how we exited.
        if watcher is not None:
            watcher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watcher


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
