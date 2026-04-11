"""BotMason AI chat router — metered AI conversations via offering_balance."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status
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
    """Fetch user by ID or raise 404."""
    user = await session.get(User, user_id)
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

    1. Check offering_balance > 0
    2. Store user's message as JournalEntry(sender='user')
    3. Load recent conversation history
    4. Call BotMason AI service
    5. Store bot's response as JournalEntry(sender='bot')
    6. Deduct 1 from offering_balance
    7. Return bot's response + remaining balance
    """
    user = await _get_user(current_user, session)

    if user.offering_balance <= 0:
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

    # Deduct offering
    user.offering_balance -= 1
    session.add(user)

    await session.commit()
    await session.refresh(bot_entry)
    await session.refresh(user)

    return ChatResponse(
        response=bot_text,
        remaining_balance=user.offering_balance,
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

    user = await _get_user(current_user, session)
    user.offering_balance += payload.amount
    session.add(user)
    await session.commit()
    await session.refresh(user)

    return BalanceAddResponse(balance=user.offering_balance, added=payload.amount)
