"""BotMason AI chat router — thin HTTP adapter over the service layer.

Every user gets ``BOTMASON_MONTHLY_CAP`` free messages per calendar month.
Once the free allocation is spent, requests fall through to
``offering_balance`` (purchased / gifted credits, no expiry).  Wallet
mechanics, LLM orchestration, and SSE framing all live in the
:mod:`services` package — this router only wires HTTP request / response
shapes to those services.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from slowapi.util import get_remote_address
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select
from starlette.requests import Request as StarletteRequest

from database import get_session
from dependencies.auth import require_admin
from errors import forbidden
from models.chat_spend import ChatSpend
from models.user import User
from rate_limit import limiter
from routers.auth import extract_user_id_from_authorization, get_current_user
from schemas.botmason import (
    BalanceAddRequest,
    BalanceAddResponse,
    BalanceResponse,
    ChatRequest,
    ChatResponse,
    UsageResponse,
)
from services import wallet as wallet_service
from services.botmason import resolve_chat_api_key
from services.chat_stream import PreflightedRequest, handle_chat_request, stream_bot_response
from services.usage import get_monthly_cap
from services.wallet import preflight_deduction, require_user_fresh, reset_monthly_usage_if_due

logger = logging.getLogger(__name__)


def _per_user_key(request: StarletteRequest) -> str:
    """Rate-limit key derived from the JWT ``sub`` claim (BUG-BM-014).

    BUG-BM-014: the old implementation hashed the entire Bearer token value,
    meaning a request without a ``Bearer `` prefix fell through to IP-based
    limiting.  An attacker could strip the header to bypass the per-user
    bucket.  The fix decodes the JWT ``sub`` (stable user id) from the token
    and keys on that.  A missing or invalid token falls back to IP so the
    limiter never receives an empty key — the route handler itself will reject
    the unauthenticated request via ``get_current_user``.

    SHA-256 is applied over the raw Authorization header (not the decoded sub)
    for the IP-fallback path, to avoid leaking the raw JWT into slowapi's
    storage backend.  When the sub is available we key on ``user:{sub}``
    directly — the sub is already non-secret (it's included in the JWT claims
    the client sees) and keying on it keeps the rate-limit bucket stable across
    token refreshes.
    """
    try:
        user_id = extract_user_id_from_authorization(request.headers.get("authorization"))
    except Exception:  # noqa: BLE001 — fall through to IP for any decode failure
        return get_remote_address(request)
    return f"user:{user_id}"


router = APIRouter(tags=["botmason"])


# Custom header used by clients to carry a user-provided LLM API key (BYOK).
# The value is consumed for a single LLM call and must never be stored or
# logged. Kept as a module constant so tests and the CORS policy can reference
# the same string without drift.
LLM_API_KEY_HEADER = "X-LLM-API-Key"  # pragma: allowlist secret

# Maximum byte length for an ``Idempotency-Key`` header value.  Client-generated
# keys are typically UUIDv4 (36 chars) or similar; 256 is generous.
_IDEM_KEY_MAX_LENGTH = 256


@dataclass(frozen=True)
class ChatHeaders:
    """Optional headers consumed by both ``/journal/chat`` endpoints.

    Bundles ``X-LLM-API-Key`` (BYOK) and ``Idempotency-Key`` so each endpoint
    signature stays under the 5-argument PLR0913 cap.  FastAPI fills the
    dataclass via a ``Depends`` factory that reads the Header dependencies
    directly — semantically identical to listing them inline.
    """

    api_key: str | None
    idempotency_key: str | None


def _resolve_chat_headers(
    x_llm_api_key: Annotated[str | None, Header(alias=LLM_API_KEY_HEADER)] = None,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> ChatHeaders:
    """FastAPI dependency factory that hands both chat-related headers as one bundle."""
    return ChatHeaders(
        api_key=resolve_chat_api_key(x_llm_api_key),
        idempotency_key=idempotency_key,
    )


def _hash_idem_key(user_id: int, raw_key: str) -> str:
    """Return a stable, opaque SHA-256 hash of ``(user_id, raw_key)``.

    The raw client token is never stored.  Hashing keeps the column
    value bounded and one-way so a DB read cannot reveal the original key.
    """
    return hashlib.sha256(f"{user_id}:{raw_key}".encode()).hexdigest()


async def _check_idempotency(
    session: AsyncSession,
    user_id: int,
    raw_key: str | None,
) -> str | None:
    """Return a cached JSON result if this key was already spent, else ``None``.

    BUG-BM-012: looks up the ``chatspend`` table for a prior row matching
    ``(user_id, idem_key)``.  Returns the stored ``result_json`` string if
    found (may be ``None`` for in-flight requests), or ``None`` if the key is
    new.  The caller is responsible for inserting a new row when proceeding
    with the charge.
    """
    if raw_key is None:
        return None
    hashed = _hash_idem_key(user_id, raw_key)
    row = (
        (
            await session.execute(
                select(ChatSpend).where(
                    ChatSpend.user_id == user_id,
                    col(ChatSpend.idem_key) == hashed,
                )
            )
        )
        .scalars()
        .first()
    )
    if row is None:
        return None
    # Return the stored result (may be None if in-flight).
    return row.result_json


async def _insert_idem_tombstone(
    session: AsyncSession,
    user_id: int,
    raw_key: str,
) -> bool:
    """Insert an in-flight idempotency tombstone row, returning False on duplicate.

    BUG-BM-012: inserts a ``ChatSpend`` row with ``result_json=NULL`` to mark
    this ``(user_id, key)`` pair as in-flight.  On a duplicate key error
    (``IntegrityError`` from the UNIQUE constraint) returns False so the
    caller knows a race-concurrent request is already processing the same key.
    """
    hashed = _hash_idem_key(user_id, raw_key)
    row = ChatSpend(user_id=user_id, idem_key=hashed)
    session.add(row)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        return False
    return True


async def _update_idem_result(
    session: AsyncSession,
    user_id: int,
    raw_key: str,
    result_json: str,
) -> None:
    """Update the tombstone row with the final serialised result."""
    hashed = _hash_idem_key(user_id, raw_key)
    row = (
        (
            await session.execute(
                select(ChatSpend).where(
                    ChatSpend.user_id == user_id,
                    col(ChatSpend.idem_key) == hashed,
                )
            )
        )
        .scalars()
        .first()
    )
    if row is not None:
        row.result_json = result_json
        session.add(row)


@router.post(
    "/journal/chat",
    response_model=ChatResponse,
    status_code=status.HTTP_201_CREATED,
)
@limiter.limit("10/minute", key_func=_per_user_key)
async def chat_with_botmason(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    payload: ChatRequest,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    headers: Annotated[ChatHeaders, Depends(_resolve_chat_headers)],
) -> ChatResponse:
    """Send a message to BotMason and receive an AI response.

    BUG-BM-012: accepts an optional ``Idempotency-Key`` header.  A second
    POST with the same key returns the cached response without a new charge.
    """
    idempotency_key = headers.idempotency_key

    # BUG-BM-012: idempotency check — return cached result on duplicate key.
    if idempotency_key is not None:
        cached = await _check_idempotency(session, current_user, idempotency_key)
        if cached is not None:
            return ChatResponse.model_validate_json(cached)
        # Insert the in-flight tombstone BEFORE the LLM call so it is committed
        # atomically with the wallet deduction by handle_chat_request's commit.
        # A concurrent duplicate request will hit the UNIQUE constraint and find
        # result_json=NULL (in-flight); the caller receives the first response once
        # this completes and updates the row.
        ok = await _insert_idem_tombstone(session, current_user, idempotency_key)
        if not ok:
            # Race: another request is in-flight with the same key.
            # Return a 409 to tell the client to retry after a short delay.
            raise HTTPException(status_code=409, detail="idempotency_key_in_flight")

    response = await handle_chat_request(session, current_user, payload.message, headers.api_key)

    # Store the final result so a retry returns the same response without
    # re-charging.  handle_chat_request committed the tombstone row above;
    # we now UPDATE result_json in a fresh implicit transaction.
    if idempotency_key is not None:
        await _update_idem_result(
            session, current_user, idempotency_key, response.model_dump_json()
        )
        await session.commit()

    return response


@router.post("/journal/chat/stream")
@limiter.limit("10/minute", key_func=_per_user_key)
async def chat_with_botmason_stream(
    request: Request,
    payload: ChatRequest,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    headers: Annotated[ChatHeaders, Depends(_resolve_chat_headers)],
) -> StreamingResponse:
    """Stream a BotMason response as Server-Sent Events.

    Pre-flight validation (auth, key format, wallet, rate limit) raises real
    HTTP errors *before* the stream opens so clients can distinguish
    "don't retry" failures (400/401/402/429) from transient mid-stream ones.
    Once streaming begins the status is pinned to 200 and any downstream
    failure surfaces as an SSE ``error`` event followed by a clean rollback —
    no partial state is committed.

    BUG-BM-006: passes ``request`` to ``stream_bot_response`` so the
    disconnect-watcher task can call ``request.is_disconnected()`` and cancel
    the upstream LLM call if the client goes away.

    BUG-BM-007: chunks are yielded as they arrive (no buffering).

    BUG-BM-012: accepts an optional ``Idempotency-Key`` header; a duplicate
    request with the same key replays the cached terminal event without a
    new charge (best-effort — in-flight duplicates return 409 or empty stream).
    """
    idempotency_key = headers.idempotency_key

    # BUG-BM-012: idempotency check before wallet deduction.
    if idempotency_key is not None:
        cached = await _check_idempotency(session, current_user, idempotency_key)
        if cached is not None:
            # Replay the cached result as a complete SSE stream.
            cached_json: str = cached  # bind for closure safety

            async def _replay() -> AsyncIterator[bytes]:
                data = json.loads(cached_json)
                yield (
                    f"event: complete\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"
                ).encode()

            return StreamingResponse(
                _replay(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
            )

    spent = await preflight_deduction(session, current_user)
    context = PreflightedRequest(
        message=payload.message,
        api_key=headers.api_key,
        spent=spent,
        remaining_messages=max(get_monthly_cap() - spent.monthly_used, 0),
        request=request,  # BUG-BM-006
    )
    # ``X-Accel-Buffering: no`` disables proxy buffering so nginx / Railway
    # forward bytes as soon as they are written.
    response_headers: dict[str, Any] = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    }
    stream = stream_bot_response(session, current_user, context)
    return StreamingResponse(stream, media_type="text/event-stream", headers=response_headers)


@router.get("/user/balance", response_model=BalanceResponse)
async def get_balance(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> BalanceResponse:
    """Return the current offering balance for the authenticated user."""
    user = await require_user_fresh(session, current_user)
    return BalanceResponse(balance=user.offering_balance)


@router.get("/user/usage", response_model=UsageResponse)
async def get_usage(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> UsageResponse:
    """Return the authenticated user's BotMason usage for the current month.

    BUG-BM-015: the original implementation committed the monthly rollover
    inside a GET handler.  A GET that commits is a side-effect that violates
    HTTP semantics and creates inconsistent commit discipline vs.
    ``preflight_deduction`` (which also calls ``reset_monthly_usage_if_due``
    but relies on its *caller* to commit).  The fix: perform the rollover
    without committing so the response reflects the correct post-reset values
    while leaving the transaction lifecycle consistent with the rest of the
    service.  The rollover UPDATE is idempotent; a subsequent ``preflight_deduction``
    that sees the stale ``monthly_reset_date`` will simply re-run the same
    no-op UPDATE.
    """
    # BUG-BM-015: compute rollover without committing — the GET endpoint must
    # not mutate persistent state.  We issue the UPDATE inside the session
    # (so the in-memory values reflect the rollover for the response) but do
    # NOT call ``session.commit()`` here.
    await reset_monthly_usage_if_due(session, current_user, datetime.now(UTC))
    # No session.commit() — BUG-BM-015.

    user = await require_user_fresh(session, current_user)
    cap = get_monthly_cap()
    return UsageResponse(
        monthly_messages_used=user.monthly_messages_used,
        monthly_messages_remaining=max(cap - user.monthly_messages_used, 0),
        monthly_cap=cap,
        monthly_reset_date=user.monthly_reset_date,
        offering_balance=user.offering_balance,
    )


@router.post("/user/balance/add", response_model=BalanceAddResponse)
@limiter.limit("5/minute")
async def add_balance(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    payload: BalanceAddRequest,
    admin: Annotated[User, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> BalanceAddResponse:
    """Add credits to the calling admin's offering balance."""
    # ``require_admin`` only returns persisted rows, so ``admin.id`` is
    # guaranteed to be set in practice.  An ``assert`` would be enough,
    # but CLAUDE.md forbids bandit-S101 suppressions in production code --
    # this narrows the type for mypy AND surfaces a clear runtime error if
    # the invariant ever breaks (e.g. a future test fixture passing a
    # detached User instance).
    if admin.id is None:
        msg = "require_admin returned an unpersisted user row"
        raise RuntimeError(msg)
    new_balance = await wallet_service.add_balance(
        session, admin.id, payload.amount, actor_user_id=admin.id
    )
    if new_balance is None:
        # TOCTOU: admin row existed when ``require_admin`` fetched it but was
        # deleted before the wallet UPDATE landed.  Same failure mode as the
        # admin-gate, so the same status keeps the client's retry logic simple.
        raise forbidden("user_not_found")

    await session.commit()
    logger.info(
        "balance_added",
        extra={"admin_id": admin.id, "added": payload.amount, "new_balance": new_balance},
    )
    return BalanceAddResponse(balance=new_balance, added=payload.amount)
