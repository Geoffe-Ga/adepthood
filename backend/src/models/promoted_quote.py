"""A quote a user promoted from something they read, to carry into a review.

A ``PromotedQuote`` row anchors a span of its source (by character offsets, with
the spanned text snapshotted so it survives later edits) that the user chose to
lift out and, optionally, weave into a subsequent reflection. The source is one
of three kinds (:class:`PromotedQuoteSourceKind`): one of the writer's own journal
entries, a published Course chapter, or a Resonance Letter written on one of the
writer's margin notes. ``source_kind`` says which, and exactly one source link
is set for it -- a DB CHECK holds the pairing for any writer, ORM or not.
"""

from datetime import UTC, datetime
from enum import StrEnum
from typing import TYPE_CHECKING, Optional

from sqlalchemy import CheckConstraint, Column, DateTime, Index, String
from sqlmodel import Field, Relationship, SQLModel

from services.journal_encryption import EncryptedString

if TYPE_CHECKING:
    from .journal_entry import JournalEntry

# The plaintext cap on a promoted quote's snapshotted text. Enforced at the write
# boundary by the schema layer (a later issue), not on the encrypted DB column —
# the constant lives here so that layer imports a single source of truth.
PROMOTED_QUOTE_TEXT_MAX = 1000

#: Width of ``source_kind``: room for a kind name, not a sentence.
PROMOTED_QUOTE_SOURCE_KIND_MAX = 16

#: Width of ``source_title``, the snapshotted Course chapter title (``VARCHAR(200)``).
PROMOTED_QUOTE_SOURCE_TITLE_MAX = 200


class PromotedQuoteSourceKind(StrEnum):
    """Where a promoted quote was lifted from.

    ``entry`` -- one of the writer's journal entries (``source_entry_id``).
    ``course`` -- a published Course chapter (``source_content_id``, which the
    chapter being pruned SET NULLs, leaving the snapshotted ``source_title``).
    ``letter`` -- the Resonance Letter on one of the writer's margin notes
    (``source_marginalia_id``).
    """

    ENTRY = "entry"
    COURSE = "course"
    LETTER = "letter"


#: The CHECK names, shared with the migration that installs them.
CK_PROMOTED_QUOTE_SOURCE_KIND_VALID = "ck_promotedquote_source_kind_valid"
CK_PROMOTED_QUOTE_SOURCE_MATCHES_KIND = "ck_promotedquote_source_matches_kind"
CK_PROMOTED_QUOTE_SOURCE_TITLE_COURSE_ONLY = "ck_promotedquote_source_title_course_only"


def _source_kind_check() -> CheckConstraint:
    """CHECK derived from the enum so the DB set can't drift from it."""
    quoted = ", ".join(f"'{kind.value}'" for kind in PromotedQuoteSourceKind)
    return CheckConstraint(f"source_kind IN ({quoted})", name=CK_PROMOTED_QUOTE_SOURCE_KIND_VALID)


def _source_matches_kind_check() -> CheckConstraint:
    """CHECK that each kind carries its own source link and no other.

    A Course quote may have lost its link (its chapter was pruned and the FK SET
    NULL), so only its *other* two links are pinned NULL.
    """
    entry = PromotedQuoteSourceKind.ENTRY.value
    course = PromotedQuoteSourceKind.COURSE.value
    letter = PromotedQuoteSourceKind.LETTER.value
    return CheckConstraint(
        f"(source_kind = '{entry}' AND source_entry_id IS NOT NULL"
        " AND source_content_id IS NULL AND source_marginalia_id IS NULL)"
        f" OR (source_kind = '{course}' AND source_entry_id IS NULL"
        " AND source_marginalia_id IS NULL)"
        f" OR (source_kind = '{letter}' AND source_marginalia_id IS NOT NULL"
        " AND source_entry_id IS NULL AND source_content_id IS NULL)",
        name=CK_PROMOTED_QUOTE_SOURCE_MATCHES_KIND,
    )


def _source_title_check() -> CheckConstraint:
    """CHECK that the plaintext title snapshot exists only on a Course quote.

    The column is stored in the clear because a chapter title is published text.
    An entry's or a letter's title is the writer's own and is encrypted where it
    lives, so it must never be copied here.
    """
    course = PromotedQuoteSourceKind.COURSE.value
    return CheckConstraint(
        f"source_title IS NULL OR source_kind = '{course}'",
        name=CK_PROMOTED_QUOTE_SOURCE_TITLE_COURSE_ONLY,
    )


class PromotedQuote(SQLModel, table=True):
    """A single anchored quote lifted from a journal entry, a Course chapter, or a letter.

    ``anchor_start`` / ``anchor_end`` are character offsets into the source's
    text; ``anchor_text`` snapshots the spanned substring so the quote survives
    later edits. ``included_in_entry_id`` points at the entry the quote was
    folded into, or NULL while it is still pending. ``stale`` marks a pending
    quote whose anchored passage a later source edit deleted or mutated, so it can
    no longer be re-anchored (mirrors ``Marginalia``).
    """

    # The hot read is "all quotes for a source entry", so index that FK; a second
    # composite index covers "a user's quotes by the entry they were folded into".
    # The two newer source links are indexed because their parents' deletes look
    # quotes up by them. The CHECKs keep anchor bounds and the kind/link pairing
    # honest at the DB level so a non-ORM writer can't persist a negative start,
    # an inverted span, or a quote whose links contradict its kind.
    __table_args__ = (
        Index("ix_promotedquote_source_entry_id", "source_entry_id"),
        Index("ix_promotedquote_user_included", "user_id", "included_in_entry_id"),
        Index("ix_promotedquote_source_content_id", "source_content_id"),
        Index("ix_promotedquote_source_marginalia_id", "source_marginalia_id"),
        CheckConstraint("anchor_start >= 0", name="ck_promotedquote_anchor_start_nonneg"),
        CheckConstraint("anchor_end > anchor_start", name="ck_promotedquote_anchor_span_positive"),
        _source_kind_check(),
        _source_matches_kind_check(),
        _source_title_check(),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    # The server default is what made every pre-existing row an entry quote; it
    # mirrors the migration so ``alembic check`` and the SQLite schema agree.
    source_kind: str = Field(
        default=PromotedQuoteSourceKind.ENTRY.value,
        sa_column=Column(
            String(PROMOTED_QUOTE_SOURCE_KIND_MAX),
            nullable=False,
            server_default=PromotedQuoteSourceKind.ENTRY.value,
        ),
    )
    # Exactly one of the three source links is set for the quote's kind (the
    # CHECK above). An entry or a letter is the writer's own, so it takes its
    # quotes with it (CASCADE); a Course chapter is published content, and
    # re-pinning it must never erase a quote a writer gathered (SET NULL).
    source_entry_id: int | None = Field(
        default=None, foreign_key="journalentry.id", ondelete="CASCADE"
    )
    source_content_id: int | None = Field(
        default=None, foreign_key="stagecontent.id", ondelete="SET NULL"
    )
    source_marginalia_id: int | None = Field(
        default=None, foreign_key="marginalia.id", ondelete="CASCADE"
    )
    # Plaintext on purpose: a snapshot of a Course chapter's published title, so
    # the quote still names its chapter after a prune. NULL for any other kind
    # (a CHECK refuses it there), so it never holds an entry's title.
    source_title: str | None = Field(default=None, max_length=PROMOTED_QUOTE_SOURCE_TITLE_MAX)
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
    # column with no relationship of its own. Optional because a Course or letter
    # quote has no source entry.
    source_entry: Optional["JournalEntry"] = Relationship(
        back_populates="promoted_quotes",
        sa_relationship_kwargs={"foreign_keys": "PromotedQuote.source_entry_id"},
    )
