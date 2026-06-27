import enum
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import Column, DateTime, Index
from sqlmodel import Field, Relationship, SQLModel

from services.journal_encryption import EncryptedString

if TYPE_CHECKING:
    from .marginalia import Marginalia
    from .user import User


class JournalTag(enum.StrEnum):
    """Extensible tag for journal entries.

    Stored as a plain string column so new values can be added without
    a database migration — the Python enum validates at the application layer.
    """

    FREEFORM = "freeform"
    STAGE_REFLECTION = "stage_reflection"
    PRACTICE_NOTE = "practice_note"
    HABIT_NOTE = "habit_note"
    # Weekly-prompt submissions share the journal stream but need a
    # distinct tag so stage-scoped aggregates (filtered by
    # ``STAGE_REFLECTION``) do not double-count them.
    WEEKLY_PROMPT = "weekly_prompt"


class EntryStatus(enum.StrEnum):
    """Lifecycle of a long-form journal entry: still being written vs committed.

    The backing column lands in a follow-up; defined here so the resonance
    feature can import a single source of truth for the value set.
    """

    DRAFT = "draft"
    FINISHED = "finished"


class JournalEntry(SQLModel, table=True):
    """Stores a chat message between the user and BotMason.

    Supports context tagging for stage reflections, practice notes, and
    habit-related thoughts.

    BUG-JOURNAL-007: hard delete is replaced with a soft-delete ``deleted_at``
    column so deleted rows can be recovered within the retention window and the
    ``LLMUsageLog.journal_entry_id`` FK is never orphaned.  All read endpoints
    filter ``deleted_at IS NULL``; a separate nightly purge job can hard-delete
    rows older than the retention window (not implemented here — follow-up
    GitHub issue).
    """

    # ``ix_journalentry_deleted_at`` is created by migration ``a0b1c2d3e4f5``
    # (BUG-JOURNAL-007).  ``ix_journalentry_user_sender_deleted`` is created by
    # migration ``e3f4a5b6c7d8`` (issue #469): ``load_recent_conversation``
    # filters on ``(user_id, sender, deleted_at)`` and orders by ``id DESC``, so
    # this composite index covers that hot chat read.  Both are declared here so
    # the model and migrations agree — ``alembic check`` otherwise reports the
    # indexes as drift and fails CI.
    __table_args__ = (
        Index("ix_journalentry_deleted_at", "deleted_at"),
        Index("ix_journalentry_user_sender_deleted", "user_id", "sender", "deleted_at"),
    )

    id: int | None = Field(default=None, primary_key=True)
    timestamp: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    # Encrypted at rest via EncryptedString (audit-destub-05b). No Field
    # max_length here (it can't coexist with sa_column, and ciphertext exceeds
    # the plaintext so the column is Text): the 10k input cap is enforced at the
    # write boundary by JournalMessageCreate / JournalBotMessageCreate
    # (max_length=JOURNAL_MESSAGE_MAX_LENGTH) plus the router's sanitizer.
    message: str = Field(sa_column=Column(EncryptedString(), nullable=False))
    # Long-form page metadata: an optional title and a draft/finished lifecycle.
    # ``message`` remains the body. ``updated_at`` tracks the last edit.
    title: str | None = Field(default=None, max_length=200)
    status: str = Field(default=EntryStatus.DRAFT, max_length=20)
    sender: str = Field(max_length=10)  # 'user' or 'bot'
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    tag: str = Field(default=JournalTag.FREEFORM, max_length=50)
    practice_session_id: int | None = Field(default=None, foreign_key="practicesession.id")
    user_practice_id: int | None = Field(default=None, foreign_key="userpractice.id")
    # BUG-JOURNAL-007: soft-delete column.  ``None`` = live row; non-None = deleted.
    deleted_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(
            DateTime(timezone=True),
            nullable=False,
            onupdate=lambda: datetime.now(UTC),
        ),
    )
    user: "User" = Relationship(back_populates="journals")
    marginalia: list["Marginalia"] = Relationship(
        back_populates="entry",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )
