"""BotMason AI chat router — metered AI conversations via offering_balance."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from errors import bad_request, payment_required
from models.journal_entry import JournalEntry
from models.user import User
from rate_limit import limiter
from routers.auth import get_current_user
from schemas.botmason import (
    BalanceAddRequest,
    BalanceAddResponse,
    BalanceResponse,
    ChatRequest,
    ChatResponse,
)
from services.botmason import CONVERSATION_HISTORY_LIMIT, generate_response

router = APIRouter(tags=["botmason"])


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
) -> ChatResponse:
    """Send a message to BotMason and receive an AI response.

    1. Atomically deduct 1 from offering_balance (prevents TOCTOU race)
    2. Store user's message as JournalEntry(sender='user')
    3. Load recent conversation history
    4. Call BotMason AI service
    5. Store bot's response as JournalEntry(sender='bot')
    6. Return bot's response + remaining balance
    """
    # Atomic balance deduction — single SQL statement, no TOCTOU race window.
    # The WHERE clause guarantees the decrement only happens if balance > 0.
    deduct_result = await session.execute(
        update(User)
        .where(col(User.id) == current_user, col(User.offering_balance) > 0)
        .values(offering_balance=col(User.offering_balance) - 1)
        .returning(col(User.offering_balance))
    )
    new_balance = deduct_result.scalar()
    if new_balance is None:
        # No rows matched — either user missing or balance already 0
        await _get_user(current_user, session)  # raises bad_request if missing
        raise payment_required("insufficient_offerings")

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

    # Generate AI response
    bot_text = await generate_response(payload.message, conversation_history)

    # Store bot's response
    bot_entry = JournalEntry(sender="bot", user_id=current_user, message=bot_text)
    session.add(bot_entry)

    await session.commit()
    await session.refresh(bot_entry)

    return ChatResponse(
        response=bot_text,
        remaining_balance=new_balance,
        bot_entry_id=bot_entry.id,
    )


@router.get("/user/balance", response_model=BalanceResponse)
async def get_balance(
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> BalanceResponse:
    """Return the current offering balance for the authenticated user."""
    user = await _get_user(current_user, session)
    return BalanceResponse(balance=user.offering_balance)


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
