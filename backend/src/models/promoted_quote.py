"""A quote a user promoted from one journal entry to carry into another.

A ``PromotedQuote`` row anchors a span of a source journal entry (by character
offsets, with the spanned text snapshotted so it survives later edits) that the
user chose to lift out and, optionally, weave into a subsequent reflection. Data-
layer only — endpoints and the promotion flow live in later issues.
"""

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import CheckConstraint, Column, DateTime, Index
from sqlmodel import Field, Relationship, SQLModel

from services.journal_encryption import EncryptedString

if TYPE_CHECKING:
    from .journal_entry import JournalEntry

# The plaintext cap on a promoted quote's snapshotted text. Enforced at the write
# boundary by the schema layer (a later issue), not on the encrypted DB column —
# the constant lives here so that layer imports a single source of truth.
PROMOTED_QUOTE_TEXT_MAX = 1000


class PromotedQuote(SQLModel, table=True):
    """A single anchored quote lifted from a source journal entry.

    ``anchor_start`` / ``anchor_end`` are character offsets into the source
    entry's text; ``anchor_text`` snapshots the spanned substring so the quote
    survives later edits. ``included_in_entry_id`` points at the entry the quote
    was folded into, or NULL while it is still pending. ``stale`` marks a pending
    quote whose anchored passage a later source edit deleted or mutated, so it can
    no longer be re-anchored (mirrors ``Marginalia``).
    """

    # The hot read is "all quotes for a source entry", so index that FK; a second
    # composite index covers "a user's quotes by the entry they were folded into".
    # The CHECKs keep anchor bounds honest at the DB level so a non-ORM writer
    # can't persist a negative start or an inverted span (mirrors ``Marginalia``).
    __table_args__ = (
        Index("ix_promotedquote_source_entry_id", "source_entry_id"),
        Index("ix_promotedquote_user_included", "user_id", "included_in_entry_id"),
        CheckConstraint("anchor_start >= 0", name="ck_promotedquote_anchor_start_nonneg"),
        CheckConstraint("anchor_end > anchor_start", name="ck_promotedquote_anchor_span_positive"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    source_entry_id: int = Field(foreign_key="journalentry.id", ondelete="CASCADE")
    anchor_start: int = Field(ge=0)
    anchor_end: int = Field(ge=1)  # DB CHECK also enforces anchor_end > anchor_start
    # Encrypted at rest via EncryptedString. No Field max_length here (it can't
    # coexist with sa_column, and ciphertext exceeds the plaintext so the column
    # is Text): the PROMOTED_QUOTE_TEXT_MAX plaintext cap is enforced at the write
    # boundary by the schema layer (a later issue), mirroring JournalEntry.message.
    anchor_text: str = Field(sa_column=Column(EncryptedString(), nullable=False))
    included_in_entry_id: int | None = Field(
        default=None,
        foreign_key="journalentry.id",
        ondelete="SET NULL",
    )
    # True once a source-body edit removed or mutated the anchored passage: the
    # quote can no longer re-anchor, so it stays for the user to resolve and is
    # never revived or deleted (mirrors ``Marginalia``). Only pending quotes go
    # stale; a quote already folded into a reflection has a frozen span.
    stale: bool = Field(default=False)
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
    # Two FKs point back to ``journalentry`` (source + optional inclusion target),
    # so this relationship MUST name ``foreign_keys`` or SQLAlchemy raises
    # AmbiguousForeignKeysError at import. ``included_in_entry_id`` is a bare FK
    # column with no relationship of its own.
    source_entry: "JournalEntry" = Relationship(
        back_populates="promoted_quotes",
        sa_relationship_kwargs={"foreign_keys": "PromotedQuote.source_entry_id"},
    )
