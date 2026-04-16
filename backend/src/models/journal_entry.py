import enum
import os
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import Column, DateTime
from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .user import User

# Feature flag for column-level encryption at rest (BUG-JOURNAL-012).
# When enabled, ``message`` is encrypted before DB write and decrypted on read
# using Fernet symmetric encryption.  The key must be provided via the
# ``JOURNAL_ENCRYPTION_KEY`` env var.
#
# TODO(#219): Implement Fernet encrypt/decrypt hooks and key rotation via KMS.
ENCRYPTION_AT_REST_ENABLED = os.getenv("JOURNAL_ENCRYPT_AT_REST", "").lower() == "true"


class JournalTag(enum.StrEnum):
    """Extensible tag for journal entries.

    Stored as a plain string column so new values can be added without
    a database migration — the Python enum validates at the application layer.
    """

    FREEFORM = "freeform"
    STAGE_REFLECTION = "stage_reflection"
    PRACTICE_NOTE = "practice_note"
    HABIT_NOTE = "habit_note"


class JournalEntry(SQLModel, table=True):
    """
    Stores a chat message between the user and BotMason. Supports context tagging
    for stage reflections, practice notes, and habit-related thoughts.
    """

    id: int | None = Field(default=None, primary_key=True)
    timestamp: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    message: str = Field(max_length=10_000)
    sender: str = Field(max_length=10)  # 'user' or 'bot'
    user_id: int = Field(foreign_key="user.id")
    tag: str = Field(default=JournalTag.FREEFORM, max_length=50)
    practice_session_id: int | None = Field(default=None, foreign_key="practicesession.id")
    user_practice_id: int | None = Field(default=None, foreign_key="userpractice.id")
    user: "User" = Relationship(back_populates="journals")
