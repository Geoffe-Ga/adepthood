"""Whether, and how often, an account has been offered the corpus decision.

One row per account, provisioned on the first completed Resonance pass rather
than at signup, and never a decision about the corpus: what it records is a
decision about being *asked*. :mod:`domain.corpus_invitation` says why that is
kept apart from :class:`models.corpus_consent.CorpusConsentEvent` -- ADR 0005
Decision 5 makes consent a two-valued auditable event, and "set the question
aside" is neither of those values and must never be readable as one.

**The row is content-free.** Two counters, an instant, and a flag. Nothing of
the writing, nothing of the reflection, and nothing that lets a reader
reconstruct either. ``completed_passes`` is a count of the moments the ruling
names, not a measure of anybody; it is never returned to a client, because a
number on an invitation turns it into a meter.

**Updated in place, on purpose.** The consent log is append-only because an
audit record that overwrites itself answers none of the questions it exists
for. This is not an audit record. The only question it answers is "may we ask
right now?", and that has exactly one current answer.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, Column, DateTime, Integer
from sqlmodel import Field, SQLModel

# Counters start at zero on the database side, so a row inserted with only its
# owner is a complete, quiet state and ``alembic check`` sees no drift.
_ZERO_SERVER_DEFAULT = "0"
# Booleans default to disabled ("0"), matching ``models.user_ui_flags``.
_DISABLED_SERVER_DEFAULT = "0"

# A count of passes is a count: never negative, and a negative value would read
# as a sentinel nobody defined.
_MIN_PASSES = 0


def _range_check(column: str) -> CheckConstraint:
    """CHECK that a pass counter is a count."""
    return CheckConstraint(
        f"{column} >= {_MIN_PASSES}", name=f"ck_corpusinvitationstate_{column}_range"
    )


class CorpusInvitationState(SQLModel, table=True):
    """One account's standing with respect to the corpus invitation.

    ``completed_passes`` counts non-intimate Resonance passes that returned a
    200 -- including a pass that kept no notes and was refunded, which is still
    a moment the writer waited through and read. ``passes_at_dismissal`` is the
    count at the most recent "Not now", so the further passes since are a
    subtraction rather than a second counter. ``do_not_ask_again`` is monotonic:
    once set it is never cleared by a later, softer decline.
    """

    __tablename__ = "corpusinvitationstate"

    # Declared here as well as in the migration so ``alembic check`` sees no
    # drift.
    __table_args__ = (_range_check("completed_passes"), _range_check("passes_at_dismissal"))

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", unique=True, ondelete="CASCADE")
    completed_passes: int = Field(
        default=0,
        sa_column=Column(Integer(), nullable=False, server_default=_ZERO_SERVER_DEFAULT),
    )
    passes_at_dismissal: int = Field(
        default=0,
        sa_column=Column(Integer(), nullable=False, server_default=_ZERO_SERVER_DEFAULT),
    )
    dismissed_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
    do_not_ask_again: bool = Field(
        default=False,
        sa_column=Column(Boolean(), nullable=False, server_default=_DISABLED_SERVER_DEFAULT),
    )
