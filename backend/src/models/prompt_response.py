from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import Column, DateTime, UniqueConstraint
from sqlmodel import Field, Relationship, SQLModel

from services.journal_encryption import EncryptedString

if TYPE_CHECKING:
    from .user import User


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
    """

    __table_args__ = (
        UniqueConstraint("user_id", "week_number", name="uq_promptresponse_user_week"),
    )

    id: int | None = Field(default=None, primary_key=True)
    week_number: int
    question: str = Field(max_length=1_000)
    response: str = Field(sa_column=Column(EncryptedString(), nullable=False))
    timestamp: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    user: "User" = Relationship(back_populates="responses")
