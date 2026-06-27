"""BotMason wallet / usage schemas."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

# Bound credit grants so a single call can neither zero-out the ledger nor
# mint billion-credit wallets.  One million is far above any legitimate gift.
BALANCE_ADD_MIN = 1
BALANCE_ADD_MAX = 1_000_000


class BalanceResponse(BaseModel):
    """Current offering balance for the authenticated user."""

    balance: int


class BalanceAddRequest(BaseModel):
    """Request to add credits to a user's offering balance.

    ``amount`` is clamped to ``[BALANCE_ADD_MIN, BALANCE_ADD_MAX]`` so that
    Pydantic rejects zero / negative / absurd grants with a 422 before any
    wallet code runs — the router no longer needs to re-check the sign.
    """

    amount: int = Field(ge=BALANCE_ADD_MIN, le=BALANCE_ADD_MAX)


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
