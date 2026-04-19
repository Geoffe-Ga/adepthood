"""BotMason AI chat router — thin HTTP adapter over the service layer.

Every user gets ``BOTMASON_MONTHLY_CAP`` free messages per calendar month.
Once the free allocation is spent, requests fall through to
``offering_balance`` (purchased / gifted credits, no expiry).  Wallet
mechanics, LLM orchestration, and SSE framing all live in the
:mod:`services` package — this router only wires HTTP request / response
shapes to those services.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Request, status
from fastapi.responses import StreamingResponse
from slowapi.util import get_remote_address
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request as StarletteRequest

from database import get_session
from dependencies.auth import require_admin
from errors import bad_request
from models.user import User
from rate_limit import limiter
from routers.auth import get_current_user
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
    """Rate-limit key that prefers the authenticated user ID over IP.

    Falls back to the remote address for anonymous / pre-auth requests so
    the limiter never receives an empty key (BUG-JOURNAL-008).
    """
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        # Use a hash-like prefix so the key space doesn't collide with IPs.
        return f"user:{auth_header}"
    return get_remote_address(request)


router = APIRouter(tags=["botmason"])


# Custom header used by clients to carry a user-provided LLM API key (BYOK).
# The value is consumed for a single LLM call and must never be stored or
# logged. Kept as a module constant so tests and the CORS policy can reference
# the same string without drift.
LLM_API_KEY_HEADER = "X-LLM-API-Key"  # pragma: allowlist secret


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
    x_llm_api_key: Annotated[str | None, Header(alias=LLM_API_KEY_HEADER)] = None,
) -> ChatResponse:
    """Send a message to BotMason and receive an AI response."""
    api_key = resolve_chat_api_key(x_llm_api_key)
    return await handle_chat_request(session, current_user, payload.message, api_key)


@router.post("/journal/chat/stream")
@limiter.limit("10/minute", key_func=_per_user_key)
async def chat_with_botmason_stream(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    payload: ChatRequest,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    x_llm_api_key: Annotated[str | None, Header(alias=LLM_API_KEY_HEADER)] = None,
) -> StreamingResponse:
    """Stream a BotMason response as Server-Sent Events.

    Pre-flight validation (auth, key format, wallet, rate limit) raises real
    HTTP errors *before* the stream opens so clients can distinguish
    "don't retry" failures (400/401/402/429) from transient mid-stream ones.
    Once streaming begins the status is pinned to 200 and any downstream
    failure surfaces as an SSE ``error`` event followed by a clean rollback —
    no partial state is committed.
    """
    api_key = resolve_chat_api_key(x_llm_api_key)
    spent = await preflight_deduction(session, current_user)
    context = PreflightedRequest(
        message=payload.message,
        api_key=api_key,
        spent=spent,
        remaining_messages=max(get_monthly_cap() - spent.monthly_used, 0),
    )
    # ``X-Accel-Buffering: no`` disables proxy buffering so nginx / Railway
    # forward bytes as soon as they are written.
    headers: dict[str, Any] = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    stream = stream_bot_response(session, current_user, context)
    return StreamingResponse(stream, media_type="text/event-stream", headers=headers)


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
    """Return the authenticated user's BotMason usage for the current month."""
    # Roll the monthly counter over in-place so callers never see stale values.
    await reset_monthly_usage_if_due(session, current_user, datetime.now(UTC))
    await session.commit()

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
    """Add credits to the calling admin's offering balance.

    BUG-BM-010: Previously any authenticated user could mint credits into their
    own wallet.  Gated on :func:`dependencies.auth.require_admin` so only
    operator-accounts can grant credit; downstream work (Prompt 12) will thread
    a target user-id and an append-only ledger through this endpoint.
    """
    if admin.id is None:
        msg = "admin user missing id after authentication"
        raise RuntimeError(msg)

    new_balance = await wallet_service.add_balance(session, admin.id, payload.amount)
    if new_balance is None:
        raise bad_request("user_not_found")

    await session.commit()
    logger.info(
        "balance_added",
        extra={"admin_id": admin.id, "added": payload.amount, "new_balance": new_balance},
    )
    return BalanceAddResponse(balance=new_balance, added=payload.amount)
