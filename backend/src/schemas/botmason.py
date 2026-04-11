"""BotMason AI chat request/response schemas."""

from __future__ import annotations

from pydantic import BaseModel, Field

CHAT_MESSAGE_MAX_LENGTH = 5_000


class ChatRequest(BaseModel):
    """Payload for sending a message to BotMason."""

    message: str = Field(min_length=1, max_length=CHAT_MESSAGE_MAX_LENGTH)


class ChatResponse(BaseModel):
    """Response from BotMason including the bot's reply and remaining balance."""

    response: str
    remaining_balance: int
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
