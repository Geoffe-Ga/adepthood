"""One account's decisions about what may be ontologized, as an event log.

ADR 0005 Decision 5 requires consent for a source to be **an auditable event,
not an implicit state**. That sentence is a claim about the shape of the
record, and this table is that shape: a row per decision, appended in the order
the decisions were made, never updated in place. Current consent is the newest
row for a ``(user_id, source)`` pair, and an account with no row for a pair has
consented to nothing for it — see
:data:`services.corpus_consent.CONSENT_GRANTED_BY_DEFAULT`.

**Why a log rather than a boolean column.** A boolean answers "may we?" and
nothing else. The questions an audit record exists for are "when did they
agree?" and "did they ever?", and both are destroyed by an update in place —
including by the update that revokes, which is exactly the moment somebody
would want the earlier answer. ``accountdeletionaudit`` keeps its receipt for
the same reason: evidence that a decision happened outlives the state the
decision produced.

**The row is content-free.** Account, source, decision, instant, and how many
fragments the decision itself deleted. Nothing from any fragment, and nothing
that would let a reader reconstruct one. The count is the same kind of evidence
``AccountDeletionAudit.row_counts`` is: it proves the purge reached the corpus
and says nothing about what it swept.

**One count, because one direction is all a decision can act in alone.** A
revocation's purge happens once, inside the decision, and is finished when the
decision is — so it is a fact about the row and lives on it. A grant's reach is
not: the sweep it authorises is bounded and stops with a remainder that a later
repeat of the same standing answer continues, so what a grant eventually
reached is a running total across sweeps rather than one number, and it lives in
:mod:`models.corpus_sweep` where there is a row per sweep to hold the addends.
Keeping a grant's count here would have recorded only the first of the sweeps
that decision authorised, sitting beside a log of all of them — a second source
of truth, and the less true one.

**Consent is per source, and the source vocabulary is
:class:`models.corpus_fragment.CorpusSource`.** One blanket agreement at signup
is not a record of which source, when — and the tier an account picked for a
piece of writing is a decision about that writing, never a decision about
whether a body of writing may be ingested. ADR 0005 rejects reading one off the
other in as many words.
"""

from __future__ import annotations

import enum
from datetime import UTC, datetime

from sqlalchemy import CheckConstraint, Column, DateTime, Index
from sqlmodel import Field, SQLModel

from models.corpus_fragment import CorpusSource


class ConsentDecision(enum.StrEnum):
    """What an account decided, in the vocabulary the column stores.

    Two values and no third. "Never asked" is the absence of a row rather than
    a value here: a pending state stored as a decision is a state something can
    accidentally treat as permission.
    """

    GRANTED = "granted"
    REVOKED = "revoked"


# Symbolic tokens from closed sets, never prose. The CHECKs below pin which.
_SOURCE_WIDTH = 20
_DECISION_WIDTH = 20

# A sweep reaches rows or it reaches none; it cannot reach a negative number of
# them, and a negative count would read as a sentinel nobody defined.
_MIN_FRAGMENTS_REACHED = 0


def _quoted(values: tuple[str, ...]) -> str:
    """Render values as a SQL literal list."""
    return ", ".join(f"'{value}'" for value in values)


def _source_check() -> CheckConstraint:
    """CHECK derived from ``CorpusSource`` so the persisted set can't drift.

    The same constraint ``corpusfragment`` carries, against the same enum: a
    consent event naming a source no fragment could ever have would be a
    permission for nothing, granted forever.
    """
    return CheckConstraint(
        f"source IN ({_quoted(tuple(source.value for source in CorpusSource))})",
        name="ck_corpusconsentevent_source_valid",
    )


def _decision_check() -> CheckConstraint:
    """CHECK derived from ``ConsentDecision`` so the persisted set can't drift."""
    return CheckConstraint(
        f"decision IN ({_quoted(tuple(decision.value for decision in ConsentDecision))})",
        name="ck_corpusconsentevent_decision_valid",
    )


def _fragments_removed_check() -> CheckConstraint:
    """CHECK that a purge count is a count."""
    return CheckConstraint(
        f"fragments_removed >= {_MIN_FRAGMENTS_REACHED}",
        name="ck_corpusconsentevent_fragments_removed_range",
    )


class CorpusConsentEvent(SQLModel, table=True):
    """One decision an account made about one source, at one instant.

    Rows are appended and never updated; see the module docstring for why an
    audit record that overwrites itself answers none of the questions it exists
    for.

    ``fragments_removed`` is zero for a grant, and for a revocation is how many
    fragments that revocation deleted — the whole of what a decision does to
    the corpus by itself, at the instant it is made. What a *grant* reached is
    not on this row at all: it is resumable, so it is one row per sweep in
    :class:`models.corpus_sweep.CorpusSweep`, each naming the decision it ran
    under. A grant that reached nothing logs no sweep, which is not the same
    claim as a grant that was never asked to reach.
    """

    __tablename__ = "corpusconsentevent"

    # The read is always "the newest decision this account made about this
    # source", so the index carries the ordering key as well as the filter.
    # Declared here as well as in the migration so ``alembic check`` sees no
    # drift.
    __table_args__ = (
        Index("ix_corpusconsentevent_user_source_id", "user_id", "source", "id"),
        _source_check(),
        _decision_check(),
        _fragments_removed_check(),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    source: str = Field(max_length=_SOURCE_WIDTH)
    decision: str = Field(max_length=_DECISION_WIDTH)
    fragments_removed: int = Field(default=0, nullable=False)
    recorded_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
