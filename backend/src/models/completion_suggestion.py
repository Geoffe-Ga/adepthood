"""Completion suggestions anchored to a journal span (habit-resonance-01).

A ``CompletionSuggestion`` is the resonance pass's proposal that a span of a
journal entry attests to completing a habit goal or a user-practice. Like
:class:`~models.marginalia.Marginalia` it anchors to a character span, but
instead of carrying a note it links to exactly one target (a goal *or* a
user-practice) and carries an accept→dismiss lifecycle. Data-layer only —
endpoints and the LLM detection pass live in later issues.
"""

import enum
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import CheckConstraint, Column, DateTime, ForeignKey, Index
from sqlmodel import Field, Relationship, SQLModel

if TYPE_CHECKING:
    from .journal_entry import JournalEntry

_ANCHOR_TEXT_MAX = 280
_LABEL_MAX = 255
_ENUM_MAX = 20


class CompletionTargetType(enum.StrEnum):
    """What a suggestion proposes the journal span attests to completing."""

    HABIT = "habit"
    PRACTICE = "practice"


class SuggestionStatus(enum.StrEnum):
    """The accept→dismiss lifecycle of a suggestion.

    ``pending`` is undecided; ``accepted`` logged the completion; ``dismissed``
    was declined by the user. A decided suggestion is terminal.
    """

    PENDING = "pending"
    ACCEPTED = "accepted"
    DISMISSED = "dismissed"


def _target_type_check() -> CheckConstraint:
    """CHECK derived from ``CompletionTargetType`` so the DB set can't drift."""
    quoted = ", ".join(f"'{t.value}'" for t in CompletionTargetType)
    return CheckConstraint(
        f"target_type IN ({quoted})",
        name="ck_completion_suggestion_target_type_valid",
    )


def _status_check() -> CheckConstraint:
    """CHECK derived from ``SuggestionStatus`` so the DB set can't drift."""
    quoted = ", ".join(f"'{s.value}'" for s in SuggestionStatus)
    return CheckConstraint(
        f"status IN ({quoted})",
        name="ck_completion_suggestion_status_valid",
    )


def _target_fk_matches_check() -> CheckConstraint:
    """Exactly the FK matching ``target_type`` is set, the other is NULL.

    A ``habit`` suggestion sets ``goal_id`` (and leaves ``user_practice_id``
    NULL); a ``practice`` suggestion sets ``user_practice_id`` (and leaves
    ``goal_id`` NULL). Keeps the polymorphic target honest at the DB level so a
    non-ORM writer cannot persist a habit suggestion pointing at a practice.
    """
    return CheckConstraint(
        "(target_type = 'habit' AND goal_id IS NOT NULL AND user_practice_id IS NULL)"
        " OR (target_type = 'practice' AND user_practice_id IS NOT NULL AND goal_id IS NULL)",
        name="ck_completion_suggestion_target_fk_matches",
    )


class CompletionSuggestion(SQLModel, table=True):
    """A single anchored completion proposal on a journal entry.

    ``anchor_start`` / ``anchor_end`` are character offsets into the entry's
    text and ``anchor_text`` snapshots the spanned substring, mirroring
    :class:`~models.marginalia.Marginalia`. Exactly one of ``goal_id`` /
    ``user_practice_id`` is set, selected by ``target_type`` and enforced by the
    ``ck_completion_suggestion_target_fk_matches`` CHECK.
    """

    # The hot read is "all suggestions for an entry", so index that FK; the
    # denormalized owner FK is indexed so "all suggestions for a user" is a range
    # scan. The polymorphic target FKs are indexed too so reverse lookups
    # ("pending suggestions for goal X" / "for user-practice Y") are range scans
    # rather than full table scans (Postgres does not auto-index FK columns).
    # CHECKs keep the enum columns, anchor bounds, and the polymorphic target
    # honest at the DB level (matching the Marginalia precedent).
    __table_args__ = (
        Index("ix_completion_suggestion_journal_entry_id", "journal_entry_id"),
        Index("ix_completion_suggestion_user_id", "user_id"),
        Index("ix_completion_suggestion_goal_id", "goal_id"),
        Index("ix_completion_suggestion_user_practice_id", "user_practice_id"),
        _target_type_check(),
        _status_check(),
        CheckConstraint("anchor_start >= 0", name="ck_completion_suggestion_anchor_start_nonneg"),
        CheckConstraint(
            "anchor_end > anchor_start",
            name="ck_completion_suggestion_anchor_span_positive",
        ),
        _target_fk_matches_check(),
    )

    id: int | None = Field(default=None, primary_key=True)
    journal_entry_id: int = Field(foreign_key="journalentry.id", ondelete="CASCADE")
    # Denormalized owner FK (also reachable via the entry) so "all suggestions
    # for a user" reads need no JOIN; writers set it to the entry's owner.
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    target_type: str = Field(max_length=_ENUM_MAX)
    # Exactly one of these is set, per ``target_type`` (see the FK-matches CHECK).
    goal_id: int | None = Field(
        default=None,
        sa_column=Column(ForeignKey("goal.id", ondelete="CASCADE"), nullable=True),
    )
    user_practice_id: int | None = Field(
        default=None,
        sa_column=Column(ForeignKey("userpractice.id", ondelete="CASCADE"), nullable=True),
    )
    label: str = Field(max_length=_LABEL_MAX)
    anchor_start: int = Field(ge=0)
    anchor_end: int = Field(ge=1)  # DB CHECK also enforces anchor_end > anchor_start
    anchor_text: str = Field(max_length=_ANCHOR_TEXT_MAX)
    status: str = Field(default=SuggestionStatus.PENDING, max_length=_ENUM_MAX)
    accepted_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
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

    entry: "JournalEntry" = Relationship(back_populates="suggestions")
