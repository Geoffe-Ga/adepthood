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

from services.journal_encryption import EncryptedString

if TYPE_CHECKING:
    from .journal_entry import JournalEntry

# Plaintext caps on the three text columns. They are no longer DB bounds — the
# columns hold ciphertext, which exceeds the plaintext — so they are enforced at
# the write boundary by ``domain.resonance`` (which sanitizes every generated
# note and essay and refuses a quote longer than the anchor cap). The constants
# live here so that layer has a single source of truth to match, the way
# ``PROMOTED_QUOTE_TEXT_MAX`` does for a promoted quote.
MARGINALIA_ANCHOR_TEXT_MAX = 280
MARGINALIA_NOTE_MAX = 600
MARGINALIA_ESSAY_MAX = 10_000


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


def _kind_check() -> CheckConstraint:
    """CHECK derived from ``MarginaliaKind`` so the DB set can't drift from the enum."""
    quoted = ", ".join(f"'{k.value}'" for k in MarginaliaKind)
    return CheckConstraint(f"kind IN ({quoted})", name="ck_marginalia_kind_valid")


def _status_check() -> CheckConstraint:
    """CHECK derived from ``MarginaliaStatus`` so the DB set can't drift from the enum."""
    quoted = ", ".join(f"'{s.value}'" for s in MarginaliaStatus)
    return CheckConstraint(f"status IN ({quoted})", name="ck_marginalia_status_valid")


class Marginalia(SQLModel, table=True):
    """A single anchored margin note on a journal entry.

    ``anchor_start`` / ``anchor_end`` are character offsets into the entry's
    text; ``anchor_text`` snapshots the spanned substring so the note survives
    later edits (and can be marked ``stale`` when it no longer matches).

    **All three text columns are encrypted at rest.** ``anchor_text`` is a
    verbatim copy of a passage that is ciphertext in ``journalentry.message``;
    storing it in the clear beside the ciphertext would hand a stolen dump the
    very sentences the source column protects (the ``promoted_quote.anchor_text``
    precedent). ``note`` and ``essay`` are deliberately encrypted too, and the
    reasoning is worth stating because it is a judgement rather than a copy:
    neither is the user's own writing — both are model-written commentary *about*
    that passage, which quotes and paraphrases it, and a note reading "the fear
    of telling him" discloses the entry as surely as the sentence it names. The
    only cost of encrypting them would be losing SQL-side search or ordering on
    the column, and nothing queries these columns by content.
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
        _kind_check(),
        _status_check(),
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
    anchor_start: int = Field(ge=0)
    anchor_end: int = Field(ge=1)  # DB CHECK also enforces anchor_end > anchor_start
    # Encrypted at rest via EncryptedString (see the class docstring for why the
    # note and essay are included). No Field max_length on any of the three: it
    # cannot coexist with sa_column, and the ciphertext exceeds the plaintext, so
    # the columns are Text and the caps above are enforced upstream.
    anchor_text: str = Field(sa_column=Column(EncryptedString(), nullable=False))
    note: str = Field(sa_column=Column(EncryptedString(), nullable=False))
    essay: str | None = Field(default=None, sa_column=Column(EncryptedString(), nullable=True))
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
