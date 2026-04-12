"""BotMason AI chat router — metered AI conversations via a two-bucket wallet.

Every user gets ``BOTMASON_MONTHLY_CAP`` free messages per calendar month.
Once the free allocation is spent, requests fall through to ``offering_balance``
(purchased / gifted credits, no expiry).  When both are empty the router
returns 402.  All wallet mutations are performed as atomic SQL statements —
no TOCTOU read/check/write patterns — so concurrent requests can never
overspend either bucket (see ``tests/test_botmason_api.py::test_concurrent_*``).
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Header, Request, status
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from errors import bad_request, payment_required
from models.journal_entry import JournalEntry
from models.llm_usage_log import LLMUsageLog
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
from services.botmason import (
    CONVERSATION_HISTORY_LIMIT,
    LLM_API_KEY_MAX_LENGTH,
    LLMResponse,
    generate_response,
    get_provider,
    provider_requires_api_key,
    validate_llm_api_key_format,
)
from services.llm_pricing import estimate_cost_usd
from services.usage import compute_next_reset, get_monthly_cap

router = APIRouter(tags=["botmason"])


# Custom header used by clients to carry a user-provided LLM API key (BYOK).
# The value is consumed for a single LLM call and must never be stored or
# logged. Kept as a module constant so tests and the CORS policy can reference
# the same string without drift.
LLM_API_KEY_HEADER = "X-LLM-API-Key"  # pragma: allowlist secret


def _resolve_user_api_key(header_value: str | None) -> str | None:
    """Return the sanitised user-supplied key, or raise 400 if malformed.

    A missing header resolves to ``None`` so the caller can decide whether to
    fall back to the server-side env var.
    """
    if header_value is None:
        return None
    key = header_value.strip()
    if not key:
        return None
    if len(key) > LLM_API_KEY_MAX_LENGTH:
        raise bad_request("invalid_llm_api_key_format")
    provider = get_provider()
    if not validate_llm_api_key_format(key, provider):
        raise bad_request("invalid_llm_api_key_format")
    return key


def _resolve_api_key_for_chat(header_value: str | None) -> str | None:
    """Choose the API key to forward for a ``/journal/chat`` request.

    Precedence: validated user-supplied header → server ``LLM_API_KEY`` env →
    none. Raises 402 ``llm_key_required`` when the active provider needs a key
    but neither source has one. The returned key is used for a single call and
    is never persisted.
    """
    user_key = _resolve_user_api_key(header_value)
    if user_key is not None:
        return user_key
    if provider_requires_api_key() and not os.getenv("LLM_API_KEY"):
        raise payment_required("llm_key_required")
    return None


async def _get_user(user_id: int, session: AsyncSession) -> User:
    """Fetch user by ID or raise 400, always reading fresh from database."""
    result = await session.execute(
        select(User).where(User.id == user_id).execution_options(populate_existing=True)
    )
    user = result.scalars().first()
    if user is None:
        msg = "user_not_found"
        raise bad_request(msg)
    return user


async def _reset_monthly_usage_if_due(
    session: AsyncSession,
    user_id: int,
    now: datetime,
) -> None:
    """Atomically roll the monthly counter over when the reset date has passed.

    The conditional WHERE clause makes this idempotent under concurrency: if
    two requests race through the boundary, the second one's predicate no
    longer matches (the first request has already advanced ``monthly_reset_date``
    to next month) and the second UPDATE is a no-op.
    """
    next_reset = compute_next_reset(now)
    await session.execute(
        update(User)
        .where(col(User.id) == user_id, col(User.monthly_reset_date) <= now)
        .values(monthly_messages_used=0, monthly_reset_date=next_reset)
    )


async def _spend_one_message(
    session: AsyncSession,
    user_id: int,
    monthly_cap: int,
) -> tuple[int, int] | None:
    """Consume exactly one BotMason message from whichever wallet has capacity.

    Returns ``(monthly_messages_used, offering_balance)`` after the deduction,
    or ``None`` when both wallets are empty (caller returns 402).  The free
    monthly allocation is drained first; only once it is at the cap do we
    touch the paid ``offering_balance``.  Each branch is a single atomic
    UPDATE … WHERE … RETURNING so concurrent requests can never overspend.
    """
    monthly_result = await session.execute(
        update(User)
        .where(
            col(User.id) == user_id,
            col(User.monthly_messages_used) < monthly_cap,
        )
        .values(monthly_messages_used=col(User.monthly_messages_used) + 1)
        .returning(col(User.monthly_messages_used), col(User.offering_balance))
    )
    monthly_row = monthly_result.first()
    if monthly_row is not None:
        return int(monthly_row[0]), int(monthly_row[1])

    balance_result = await session.execute(
        update(User)
        .where(col(User.id) == user_id, col(User.offering_balance) > 0)
        .values(offering_balance=col(User.offering_balance) - 1)
        .returning(col(User.monthly_messages_used), col(User.offering_balance))
    )
    balance_row = balance_result.first()
    if balance_row is not None:
        return int(balance_row[0]), int(balance_row[1])

    return None


@router.post(
    "/journal/chat",
    response_model=ChatResponse,
    status_code=status.HTTP_201_CREATED,
)
@limiter.limit("10/minute")
async def chat_with_botmason(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    payload: ChatRequest,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
    x_llm_api_key: str | None = Header(default=None, alias=LLM_API_KEY_HEADER),
) -> ChatResponse:
    """Send a message to BotMason and receive an AI response.

    1. Resolve the LLM API key (user-supplied header > server env var)
    2. Lazily roll over the monthly counter if the reset date has passed
    3. Atomically spend one message from the free monthly bucket or, once that
       bucket is full, from ``offering_balance`` (prevents TOCTOU races)
    4. Store user's message as JournalEntry(sender='user')
    5. Load recent conversation history
    6. Call BotMason AI service
    7. Store bot's response as JournalEntry(sender='bot')
    8. Return bot's response + remaining wallet state

    The ``X-LLM-API-Key`` header is validated for format and forwarded to the
    provider for this single request. It is never logged, never written to
    the database, and never echoed back in the response.
    """
    # Resolve the key BEFORE deducting balance so a malformed key (400) or a
    # missing key on a provider that needs one (402) never costs the user a
    # message. Fails fast without touching the DB.
    api_key = _resolve_api_key_for_chat(x_llm_api_key)

    now = datetime.now(UTC)
    monthly_cap = get_monthly_cap()

    # Roll over the monthly counter before metering so a first-of-the-month
    # request gets a freshly zeroed bucket.  The WHERE clause makes this a
    # no-op when the reset date is still in the future.
    await _reset_monthly_usage_if_due(session, current_user, now)

    spent = await _spend_one_message(session, current_user, monthly_cap)
    if spent is None:
        # Neither bucket had capacity.  Distinguish "user vanished mid-request"
        # (extremely unlikely, but would otherwise surface as a misleading 402)
        # from the real payment-required case.
        await _get_user(current_user, session)  # raises bad_request if missing
        raise payment_required("insufficient_offerings")
    monthly_used, new_balance = spent
    remaining_messages = max(monthly_cap - monthly_used, 0)

    # Store user's message
    user_entry = JournalEntry(sender="user", user_id=current_user, message=payload.message)
    session.add(user_entry)
    await session.flush()

    # Load recent conversation history for context
    history_query = (
        select(JournalEntry)
        .where(JournalEntry.user_id == current_user)
        .order_by(col(JournalEntry.id).desc())
        .limit(CONVERSATION_HISTORY_LIMIT)
    )
    result = await session.execute(history_query)
    history_entries = list(reversed(result.scalars().all()))

    conversation_history = [
        {"sender": entry.sender, "message": entry.message} for entry in history_entries
    ]

    # Generate AI response. ``api_key`` is passed by value for a single call
    # and is discarded when this function returns.
    llm_response = await generate_response(
        payload.message,
        conversation_history,
        api_key=api_key,
    )

    # Store bot's response
    bot_entry = JournalEntry(sender="bot", user_id=current_user, message=llm_response.text)
    session.add(bot_entry)
    # Flush so ``bot_entry.id`` is available as the FK for the usage log row.
    # Both rows commit together below, so a rollback at commit-time still
    # leaves the log consistent with the journal.
    await session.flush()

    _record_llm_usage(session, current_user, bot_entry.id, llm_response)

    await session.commit()
    await session.refresh(bot_entry)

    # Look up the freshly-advanced reset date so the client can surface an
    # accurate "resets in N days" countdown without a second round-trip.
    user_after = await _get_user(current_user, session)

    return ChatResponse(
        response=llm_response.text,
        remaining_balance=new_balance,
        remaining_messages=remaining_messages,
        monthly_reset_date=user_after.monthly_reset_date,
        bot_entry_id=bot_entry.id,
    )


def _record_llm_usage(
    session: AsyncSession,
    user_id: int,
    journal_entry_id: int | None,
    llm_response: LLMResponse,
) -> None:
    """Append an :class:`LLMUsageLog` row for a single chat call.

    The log row is staged on the caller's session so it commits in the same
    transaction as the bot's :class:`JournalEntry`.  ``journal_entry_id`` is
    typed ``int | None`` because SQLModel exposes the primary key that way
    until flush; the caller is responsible for flushing before invoking this
    helper and we assert the invariant here to fail loudly rather than write
    a row with a NULL FK.
    """
    if journal_entry_id is None:  # pragma: no cover - defensive; caller flushes first
        msg = "journal_entry_id must be set before logging LLM usage"
        raise RuntimeError(msg)

    session.add(
        LLMUsageLog(
            user_id=user_id,
            provider=llm_response.provider,
            model=llm_response.model,
            prompt_tokens=llm_response.prompt_tokens,
            completion_tokens=llm_response.completion_tokens,
            total_tokens=llm_response.total_tokens,
            estimated_cost_usd=estimate_cost_usd(
                llm_response.model,
                llm_response.prompt_tokens,
                llm_response.completion_tokens,
            ),
            journal_entry_id=journal_entry_id,
        )
    )


@router.get("/user/balance", response_model=BalanceResponse)
async def get_balance(
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> BalanceResponse:
    """Return the current offering balance for the authenticated user."""
    user = await _get_user(current_user, session)
    return BalanceResponse(balance=user.offering_balance)


@router.get("/user/usage", response_model=UsageResponse)
async def get_usage(
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> UsageResponse:
    """Return the authenticated user's BotMason usage for the current month.

    Rolls the monthly counter over in-place when the stored reset date has
    passed so the caller never sees stale values — a user who opens the app
    on the first of the month gets a freshly zeroed usage card without
    waiting for their next chat request.
    """
    now = datetime.now(UTC)
    await _reset_monthly_usage_if_due(session, current_user, now)
    await session.commit()

    user = await _get_user(current_user, session)
    cap = get_monthly_cap()
    remaining = max(cap - user.monthly_messages_used, 0)
    return UsageResponse(
        monthly_messages_used=user.monthly_messages_used,
        monthly_messages_remaining=remaining,
        monthly_cap=cap,
        monthly_reset_date=user.monthly_reset_date,
        offering_balance=user.offering_balance,
    )


@router.post("/user/balance/add", response_model=BalanceAddResponse)
@limiter.limit("5/minute")
async def add_balance(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    payload: BalanceAddRequest,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> BalanceAddResponse:
    """Add credits to the authenticated user's offering balance."""
    if payload.amount <= 0:
        raise bad_request("amount_must_be_positive")

    # Atomic balance addition — single SQL statement, no lost-update window.
    result = await session.execute(
        update(User)
        .where(col(User.id) == current_user)
        .values(offering_balance=col(User.offering_balance) + payload.amount)
        .returning(col(User.offering_balance))
    )
    new_balance = result.scalar()
    if new_balance is None:
        msg = "user_not_found"
        raise bad_request(msg)

    await session.commit()

    return BalanceAddResponse(balance=new_balance, added=payload.amount)
