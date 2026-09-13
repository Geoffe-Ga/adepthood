"""Durable exactly-once receipts for explicit goal-completion deltas."""

from __future__ import annotations

from datetime import UTC, date, datetime

from sqlalchemy import Column, Date, DateTime, Float, ForeignKey, String, UniqueConstraint
from sqlmodel import Field, SQLModel

# Raw keys are accepted only up to this boundary; the database stores a bounded
# SHA-256 digest instead of caller-controlled text.
GOAL_COMPLETION_IDEMPOTENCY_KEY_MAX_LENGTH = 255
_DIGEST_COLUMN_WIDTH = 64


class GoalCompletionSpend(SQLModel, table=True):
    """Record one explicit signed mutation that has already been applied.

    The receipt is committed in the same transaction as its arithmetic. The
    unique ``(user_id, idem_key)`` pair therefore turns transport retries and
    offline replay into reads, even when they arrive on another worker.
    Request identity fields are retained so reusing a key for different work is
    rejected rather than silently returning an unrelated result.
    """

    __tablename__ = "goalcompletionspend"
    __table_args__ = (
        UniqueConstraint("user_id", "idem_key", name="uq_goalcompletionspend_user_idem_key"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    idem_key: str = Field(
        sa_column=Column(String(_DIGEST_COLUMN_WIDTH), nullable=False),
    )
    goal_id: int = Field(
        sa_column=Column(ForeignKey("goal.id", ondelete="CASCADE"), nullable=False),
    )
    local_day: date = Field(sa_column=Column(Date, nullable=False))
    completed_units: float = Field(sa_column=Column(Float, nullable=False))
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
