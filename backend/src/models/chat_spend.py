"""Idempotency store for chat-spend operations (BUG-BM-012).

One row per ``(user_id, idem_key)`` pair records whether a ``/journal/chat``
or ``/journal/chat/stream`` request has already been charged.  Duplicate
requests with the same key return the cached result without a second wallet
deduction.

The ``idem_key`` column stores a SHA-256 digest of the raw ``Idempotency-Key``
header value so the raw client token is never persisted (same pattern used
for rate-limit keys in other routers).  The unique constraint is on the
``(user_id, idem_key)`` pair so keys from different users cannot collide.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, String, UniqueConstraint
from sqlmodel import Field, SQLModel

# SHA-256 hex digest is 64 chars; column headroom to 128 for future hash
# algorithm migrations.
_IDEM_KEY_COLUMN_WIDTH = 128


class ChatSpend(SQLModel, table=True):
    """Record of a deduplicated chat-spend event (BUG-BM-012).

    A row is inserted atomically with the wallet deduction; on a duplicate
    ``idem_key`` the ``UNIQUE`` constraint fires an ``IntegrityError`` which
    the caller translates to "return cached result".

    ``result_json`` stores the serialised :class:`ChatResponse` / SSE final
    payload so a duplicate request can replay the same response body without
    hitting the LLM again.  ``NULL`` during the in-flight window (between
    deduction and LLM response) so a crash mid-flight leaves the row in a
    "pending" state that the cleanup job can detect.
    """

    __tablename__ = "chatspend"
    __table_args__ = (UniqueConstraint("user_id", "idem_key", name="uq_chatspend_user_idem_key"),)

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True, ondelete="CASCADE")
    idem_key: str = Field(
        sa_column=Column(
            String(_IDEM_KEY_COLUMN_WIDTH),
            nullable=False,
            index=True,
        ),
    )
    # Serialised response payload (JSON string).  Set to NULL during in-flight;
    # populated once the LLM call completes and the row is updated.
    result_json: str | None = Field(default=None, sa_column=Column(String, nullable=True))
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
