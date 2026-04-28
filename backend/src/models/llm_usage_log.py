"""Per-request LLM cost + token accounting.

One row per successful ``/journal/chat`` call.  The table is append-only —
never updated, never deleted by the application code — so it doubles as an
audit log for cost investigations.  Aggregates (total spend, per-user, per-
model breakdowns) are computed on read by the admin stats endpoint.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import Column, DateTime, Numeric
from sqlmodel import Field, SQLModel

# 12 / 6 keeps the column small enough for a typical OLTP page footprint
# while still expressing sub-cent precision (one micro-dollar per token
# is well below any provider's published rate).  Existing float rows are
# migrated to ``NUMERIC(12, 6)`` by the same revision that introduces
# this file's Decimal type — see the Alembic migration referenced in
# the commit message.
_COST_PRECISION = 12
_COST_SCALE = 6

# Sentinel default for rows where the pricing table did not know the
# model.  ``None`` makes the absence explicit so the admin endpoint can
# distinguish "free model" from "we forgot to price this model"
# (BUG-BM-008).  Pre-Decimal rows that landed with ``0.0`` remain
# readable as ``Decimal('0.000000')`` because the migration cast runs
# before the column type changes.
DEFAULT_COST: Decimal | None = None


class LLMUsageLog(SQLModel, table=True):
    """Token counts + estimated USD cost for a single LLM call.

    ``estimated_cost_usd`` is derived from ``prompt_tokens`` /
    ``completion_tokens`` via the pricing table in
    :mod:`services.llm_pricing`.  It is stored on the row so historical rows
    survive unchanged when the pricing table is updated for future requests.

    ``estimated_cost_usd`` is a :class:`Decimal` (BUG-ADMIN-004 / BUG-BM-008)
    so every aggregate sum across the table is exact.  The column is
    nullable: a ``None`` value means "unknown model — pricing table missed
    it" and is logged as a warning so ops can fill in the rate, not
    silently averaged in as ``$0`` (which the previous float default did).

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
    estimated_cost_usd: Decimal | None = Field(
        default=DEFAULT_COST,
        sa_column=Column(Numeric(precision=_COST_PRECISION, scale=_COST_SCALE), nullable=True),
    )
    journal_entry_id: int = Field(foreign_key="journalentry.id", index=True)
