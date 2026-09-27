from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import Column, DateTime, Index, String, UniqueConstraint
from sqlmodel import Field, Relationship, SQLModel

from security.idempotency import IDEMPOTENCY_DIGEST_COLUMN_WIDTH
from services.journal_encryption import EncryptedString

if TYPE_CHECKING:
    from .user import User

# Detached column used ONLY to build the partial-index WHERE expression (the
# :mod:`models.feedback` shape): it matches the real ``idem_key`` column by name
# at DDL-compile time and is never attached to the table itself.
_IDEM_KEY_COLUMN = Column("idem_key", String(IDEMPOTENCY_DIGEST_COLUMN_WIDTH), nullable=True)


class PromptResponse(SQLModel, table=True):
    """Captures responses to weekly prompts within the APTITUDE program.

    The ``(user_id, week_number)`` unique constraint prevents duplicate
    responses at the database level, closing the TOCTOU race between the
    application-level SELECT and INSERT (BUG-JOURNAL-003).

    ``response`` is encrypted at rest because it is not merely *like* journal
    text — submitting a prompt response writes the identical sanitized string
    into ``journalentry.message`` in the same transaction, so this row is a
    byte-for-byte duplicate of a column that is ciphertext. Its plaintext cap is
    ``schemas.prompt.PROMPT_RESPONSE_MAX_LENGTH``, applied by the router's
    sanitizer — the column itself is ``Text``, because the ciphertext exceeds any
    plaintext bound. ``question`` stays plaintext: it is the shared curriculum's
    prompt, identical for every account and already committed to this repository,
    so encrypting it would protect nothing while making the row harder to reason
    about.

    ``idem_key`` is the digest of ``(user_id, Idempotency-Key)`` for a keyed
    submission, NULL otherwise (#2936). The week constraint already makes a
    second row impossible; what the key adds is *recognition*. A retry whose
    first attempt landed but whose answer was lost is the writer's own answer
    coming back, so it is answered with that row rather than refused as though
    somebody else had taken the week.
    """

    __table_args__ = (
        UniqueConstraint("user_id", "week_number", name="uq_promptresponse_user_week"),
        Index(
            "ix_promptresponse_user_idem_key",
            "user_id",
            "idem_key",
            unique=True,
            postgresql_where=_IDEM_KEY_COLUMN.is_not(None),
            sqlite_where=_IDEM_KEY_COLUMN.is_not(None),
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    week_number: int
    # Which of the stage's prompts this row answers, 1-based. A stage carries
    # three to five prompts, so the week alone no longer identifies one.
    # ``None`` on rows written before prompts became individually addressable;
    # those fall back to the prompt their week draws.
    prompt_ordinal: int | None = Field(default=None)
    question: str = Field(max_length=1_000)
    response: str = Field(sa_column=Column(EncryptedString(), nullable=False))
    timestamp: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    idem_key: str | None = Field(
        default=None,
        sa_column=Column(String(IDEMPOTENCY_DIGEST_COLUMN_WIDTH), nullable=True),
    )
    user: "User" = Relationship(back_populates="responses")
