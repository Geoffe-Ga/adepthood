"""DB-backed idempotency store for practice-session creation.

Replaces a per-process ``dict`` (which only deduplicated within one worker and
lost its state on restart): two requests carrying the same ``Idempotency-Key``
on different workers could both insert a fresh ``PracticeSession``. One row per
``(user_id, idem_key)`` records the deduplicated ``session_id``; the UNIQUE
constraint lets the database serialise the check-then-insert race across workers
without process-local locks.

Unlike chat (slow LLM calls need an in-flight tombstone window), practice-session
writes are fast and synchronous, so there is no tombstone: the row is inserted in
the same transaction as the session and always carries a real ``session_id``.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, String, UniqueConstraint
from sqlmodel import Field, SQLModel

# SHA-256 hex digest is 64 chars; column headroom to 128 for a future hash
# algorithm migration.
_IDEM_KEY_COLUMN_WIDTH = 128


class PracticeSessionSpend(SQLModel, table=True):
    """Records that a ``(user_id, idem_key)`` pair already created a session.

    A row is inserted atomically alongside the ``PracticeSession`` it
    deduplicates; on a duplicate ``idem_key`` the ``UNIQUE`` constraint raises
    an ``IntegrityError`` which the service translates to "return the recorded
    session". The raw ``Idempotency-Key`` header is never stored — ``idem_key``
    is a SHA-256 digest of ``(user_id, raw_key)``.
    """

    __tablename__ = "practicesessionspend"
    __table_args__ = (
        UniqueConstraint("user_id", "idem_key", name="uq_practicesessionspend_user_idem_key"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True, ondelete="CASCADE")
    idem_key: str = Field(
        sa_column=Column(String(_IDEM_KEY_COLUMN_WIDTH), nullable=False, index=True),
    )
    # The deduplicated session. ``ondelete=CASCADE`` so deleting the session
    # drops its idempotency record too — a later replay then logs a fresh
    # session rather than resolving a dangling id (matching the old in-memory
    # behaviour where a vanished session id fell through to a new insert).
    session_id: int = Field(foreign_key="practicesession.id", ondelete="CASCADE")
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
