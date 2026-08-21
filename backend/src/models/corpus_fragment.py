"""One ontologized fragment of a user's own writing.

**This store is isolated, not operator-blind, and the difference is the whole
point of ADR 0005 Decision 1(b).** These rows live in the operator's Postgres
and the operator can read them. The ``user_id`` foreign key partitions the
table between accounts — it says nothing whatever about who *outside* the table
can read it. Encryption at rest does not change that either: ``content`` is
encrypted with Fernet keys the operator configures via
``JOURNAL_ENCRYPTION_KEYS``, which defends against a stolen disk, not against
the party holding the key. Anyone reading this docstring looking for
operator-blindness is looking at the wrong layer: that is the confidential
vault, and it remains an upgrade rather than a thing this table provides.

**INTIMATE cannot live here.** ADR 0005 Decision 2 makes the exclusion
structural rather than advisory, and this table carries the innermost of the
three barriers: ``ck_corpusfragment_tier_retrievable`` refuses the tier at the
database, so a fragment of intimate writing is not a row that exists and then
gets filtered — it is a row that cannot be written by any caller, including one
added later that forgets the guard in :mod:`services.corpus_store`.

The ontology itself is not redefined here. ``frequency_weights`` is keyed by
the ``F1``..``F10`` codes of :mod:`domain.frequencies`, which are the same ten
developmental positions as the APTITUDE Stages, the Aspects of Wholeness and
the Wavelength Modes — one set under four names, joined on colour. Codes rather
than names are stored for the reason that module gives: the names drift between
vocabularies and a rename upstream must not invalidate stored classifications.
"""

from __future__ import annotations

import enum
from datetime import UTC, datetime
from typing import Final

from sqlalchemy import JSON, CheckConstraint, Column, DateTime, Float, Index
from sqlalchemy.dialects.postgresql import ARRAY as PG_ARRAY
from sqlmodel import Field, SQLModel

from models.journal_entry import JournalClassification
from services.journal_encryption import EncryptedString


class CorpusSource(enum.StrEnum):
    """Where a fragment came from.

    ``journal`` is writing composed in this app. ``upload`` is a file the user
    handed over directly, and ``import`` is material pulled from a service they
    write on elsewhere — the two the import surface will produce. Recorded
    because "what did I actually give this thing?" is a question a user is
    entitled to an answer to, and a column is the only place that answer can
    come from later.
    """

    JOURNAL = "journal"
    UPLOAD = "upload"
    IMPORT = "import"


#: The tiers a fragment may carry. INTIMATE is absent, and its absence is the
#: privacy guarantee rather than a default that could be widened: the CHECK
#: below is generated from this tuple, so adding the intimate tier here would
#: have to be a deliberate, reviewed edit to a constant whose docstring says
#: not to.
RETRIEVABLE_TIERS: Final[tuple[JournalClassification, ...]] = (
    JournalClassification.PUBLIC,
    JournalClassification.PERSONAL,
)

#: The tier that may never enter this table. Named rather than implied, so a
#: reader of the CHECK can see what it is keeping out.
EXCLUDED_TIER: Final[JournalClassification] = JournalClassification.INTIMATE

# Symbolic tokens, never prose: both columns hold one value from a small closed
# set, and the CHECKs below pin which.
_TIER_WIDTH = 20
_SOURCE_WIDTH = 20

# Confidence and every frequency weight are fractions, exactly as the
# classifier produces them.
_MIN_CONFIDENCE = 0.0
_MAX_CONFIDENCE = 1.0


def _quoted(values: tuple[str, ...]) -> str:
    """Render values as a SQL literal list."""
    return ", ".join(f"'{value}'" for value in values)


def _tier_check() -> CheckConstraint:
    """CHECK that the tier is retrievable — which is to say, never intimate.

    Derived from :data:`RETRIEVABLE_TIERS` so the persisted set cannot drift
    from the constant the retrieval query reads. The migration installs the
    identical SQL.
    """
    return CheckConstraint(
        f"tier IN ({_quoted(tuple(tier.value for tier in RETRIEVABLE_TIERS))})",
        name="ck_corpusfragment_tier_retrievable",
    )


def _source_check() -> CheckConstraint:
    """CHECK derived from ``CorpusSource`` so the persisted set can't drift."""
    return CheckConstraint(
        f"source IN ({_quoted(tuple(source.value for source in CorpusSource))})",
        name="ck_corpusfragment_source_valid",
    )


def _confidence_check() -> CheckConstraint:
    """CHECK that the classifier's confidence stayed a fraction."""
    return CheckConstraint(
        f"overall_confidence BETWEEN {_MIN_CONFIDENCE} AND {_MAX_CONFIDENCE}",
        name="ck_corpusfragment_confidence_range",
    )


class CorpusFragment(SQLModel, table=True):
    """One classified piece of a single account's corpus.

    See the module docstring for the two properties that govern this table:
    isolation is not operator-blindness, and the intimate tier cannot be
    persisted here at all.

    ``embedding`` is nullable because classification and embedding are separate
    passes that fail separately — a fragment whose frequencies are known but
    whose embedding provider was down is still worth keeping, and retrieval
    says exactly what such a fragment can and cannot answer.
    """

    # ``ix_corpusfragment_user_tier_created`` covers the retrieval read, which
    # filters on ``(user_id, tier)`` and orders by ``created_at``. Declared here
    # as well as in the migration so ``alembic check`` sees no drift.
    __table_args__ = (
        Index("ix_corpusfragment_user_tier_created", "user_id", "tier", "created_at"),
        _tier_check(),
        _source_check(),
        _confidence_check(),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    source: str = Field(max_length=_SOURCE_WIDTH)
    # Privacy tier, pinned by ``ck_corpusfragment_tier_retrievable`` to the two
    # tiers this store is permitted to hold.
    tier: str = Field(max_length=_TIER_WIDTH)
    # Encrypted at rest via EncryptedString, matching the journal row this is
    # usually derived from. No ``max_length``: it cannot coexist with
    # ``sa_column``, the ciphertext exceeds the plaintext, and the per-fragment
    # ceiling is enforced at the write boundary by the classifier's
    # ``MAX_FRAGMENT_CHARS``.
    content: str = Field(sa_column=Column(EncryptedString(), nullable=False))
    # ``{"F5": 0.9, "F3": 0.2}`` — the classifier's weights under their codes,
    # omitting frequencies the fragment does not carry rather than listing them
    # at zero. Deliberately not normalised to a distribution: conviction is the
    # quantity of interest and normalising would destroy it.
    frequency_weights: dict[str, float] = Field(
        default_factory=dict, sa_column=Column(JSON, nullable=False)
    )
    overall_confidence: float = Field(default=0.0)
    # A dense vector of whatever width the embedding provider produces. Stored
    # as a plain float array rather than a pgvector column: retrieval ranks a
    # bounded candidate pool in Python, so no ANN index is consulted, and an
    # extension-typed column would be unusable under the SQLite test database
    # where every assertion about ranking is made.
    embedding: list[float] | None = Field(
        default=None, sa_column=Column(PG_ARRAY(Float), nullable=True)
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
