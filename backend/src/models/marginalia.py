"""AI margin notes anchored to spans of a journal page.

A ``Marginalia`` row is a short note (optionally expanded into an essay) that the
resonance feature attaches to a character span of a journal entry. Data-layer
only — endpoints and LLM generation live in later issues.
"""

import enum
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import CheckConstraint, Column, DateTime, Index
from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .journal_entry import JournalEntry

_ANCHOR_TEXT_MAX = 280
_NOTE_MAX = 600
_ESSAY_MAX = 10_000


class MarginaliaKind(enum.StrEnum):
    """What a margin note surfaces about the anchored span."""

    THEME = "theme"
    CONNECTION = "connection"
    SYMBOL = "symbol"


class MarginaliaStatus(enum.StrEnum):
    """Whether a note still anchors cleanly or has drifted.

    ``active`` anchors cleanly; ``stale`` means the underlying text changed
    enough that the note may no longer fit its span.
    """

    ACTIVE = "active"
    STALE = "stale"


class Marginalia(SQLModel, table=True):
    """A single anchored margin note on a journal entry.

    ``anchor_start`` / ``anchor_end`` are character offsets into the entry's
    text; ``anchor_text`` snapshots the spanned substring so the note survives
    later edits (and can be marked ``stale`` when it no longer matches).
    """

    # The hot read is "all marginalia for an entry", so index the FK. The CHECK
    # constraints keep enum-valued columns and anchor bounds honest at the DB
    # level (matching the Practice.mode / PracticeRecipeStep.position precedents),
    # so a non-ORM writer can't persist an invalid kind/status or inverted span.
    __table_args__ = (
        Index("ix_marginalia_journal_entry_id", "journal_entry_id"),
        # Index the denormalized owner FK so "all marginalia for a user" is a
        # range scan, not a full-table scan (the reason the column exists).
        Index("ix_marginalia_user_id", "user_id"),
        CheckConstraint(
            "kind IN ('theme', 'connection', 'symbol')",
            name="ck_marginalia_kind_valid",
        ),
        CheckConstraint(
            "status IN ('active', 'stale')",
            name="ck_marginalia_status_valid",
        ),
        CheckConstraint("anchor_start >= 0", name="ck_marginalia_anchor_start_nonneg"),
        CheckConstraint("anchor_end > anchor_start", name="ck_marginalia_anchor_span_positive"),
        # essay and its generated-at timestamp are set together or not at all.
        CheckConstraint(
            "(essay IS NULL) = (essay_generated_at IS NULL)",
            name="ck_marginalia_essay_timestamp_paired",
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    journal_entry_id: int = Field(foreign_key="journalentry.id", ondelete="CASCADE")
    # Denormalized owner FK (in addition to the owner reachable via the entry) so
    # "all marginalia for a user" reads need no JOIN. Writers must set it to the
    # entry's owner; enforcing that invariant is tracked for the endpoint layer.
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    kind: str = Field(max_length=20)
    anchor_start: int
    anchor_end: int
    anchor_text: str = Field(max_length=_ANCHOR_TEXT_MAX)
    note: str = Field(max_length=_NOTE_MAX)
    essay: str | None = Field(default=None, max_length=_ESSAY_MAX)
    essay_generated_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    status: str = Field(default=MarginaliaStatus.ACTIVE, max_length=20)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(
            DateTime(timezone=True),
            nullable=False,
            onupdate=lambda: datetime.now(UTC),
        ),
    )

    entry: "JournalEntry" = Relationship(back_populates="marginalia")
