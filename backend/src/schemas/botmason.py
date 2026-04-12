"""BotMason AI chat request/response schemas."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

CHAT_MESSAGE_MAX_LENGTH = 5_000


class ChatRequest(BaseModel):
    """Payload for sending a message to BotMason."""

    message: str = Field(min_length=1, max_length=CHAT_MESSAGE_MAX_LENGTH)


class ChatResponse(BaseModel):
    """Response from BotMason including the bot's reply and remaining wallet state.

    ``remaining_balance`` reports purchased/gifted credits; ``remaining_messages``
    reports the free allocation left in the current calendar month.  Clients
    should prefer ``remaining_messages`` for headline UI and fall back to
    ``remaining_balance`` only once the free tier is exhausted.
    """

    response: str
    remaining_balance: int
    remaining_messages: int
    monthly_reset_date: datetime
    bot_entry_id: int


class BalanceResponse(BaseModel):
    """Current offering balance for the authenticated user."""

    balance: int


class BalanceAddRequest(BaseModel):
    """Request to add credits to a user's offering balance."""

    amount: int


class BalanceAddResponse(BaseModel):
    """Response after adding credits."""

    balance: int
    added: int


class UsageResponse(BaseModel):
    """Monthly BotMason usage snapshot for the authenticated user.

    ``monthly_messages_remaining`` is derived from ``monthly_cap`` and
    ``monthly_messages_used``; it is clamped at zero so the client never has
    to defend against negative values.
    """

    monthly_messages_used: int
    monthly_messages_remaining: int
    monthly_cap: int
    monthly_reset_date: datetime
    offering_balance: int
