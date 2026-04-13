"""Per-request LLM cost + token accounting.

One row per successful ``/journal/chat`` call.  The table is append-only —
never updated, never deleted by the application code — so it doubles as an
audit log for cost investigations.  Aggregates (total spend, per-user, per-
model breakdowns) are computed on read by the admin stats endpoint.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import Column, DateTime
from sqlmodel import Field, SQLModel


class LLMUsageLog(SQLModel, table=True):
    """Token counts + estimated USD cost for a single LLM call.

    ``estimated_cost_usd`` is derived from ``prompt_tokens`` /
    ``completion_tokens`` via the pricing table in
    :mod:`services.llm_pricing`.  It is stored on the row so historical rows
    survive unchanged when the pricing table is updated for future requests.

    ``journal_entry_id`` points at the bot's reply (``sender='bot'``) so a
    single JOIN reconstructs the conversational context of any logged call.
    """

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    timestamp: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False, index=True),
    )
    provider: str = Field(max_length=32, index=True)
    model: str = Field(max_length=128, index=True)
    prompt_tokens: int = Field(default=0, ge=0)
    completion_tokens: int = Field(default=0, ge=0)
    total_tokens: int = Field(default=0, ge=0)
    estimated_cost_usd: float = Field(default=0.0, ge=0.0)
    journal_entry_id: int = Field(foreign_key="journalentry.id", index=True)
