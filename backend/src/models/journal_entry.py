import enum
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import CheckConstraint, Column, DateTime, Index, String, and_
from sqlmodel import Field, Relationship, SQLModel

from domain.constants import TOTAL_STAGES
from domain.reflection_hierarchy import ReflectionLevel
from services.journal_encryption import EncryptedString

# The inclusive lower bound of a valid Aspect tag. The upper bound is
# ``TOTAL_STAGES`` (an Aspect == a stage 1..TOTAL_STAGES), so the range never
# drifts from the curriculum length.
ASPECT_MIN = 1

# Maximum length of a journal entry title. Shared with the write-boundary
# schemas (JournalEntryUpdate, PromptSubmit) so the DB column bound and the
# request validation can't drift.
JOURNAL_TITLE_MAX_LENGTH = 200

# Bound at module scope so the partial unique index's ``*_where`` predicates can
# resolve these columns by name at table-creation time (mirrors
# :mod:`models.invitation_signal`). They are detached references used only by the
# predicate — the real columns are declared as ``Field``s on the model — so both
# Postgres and SQLite render the same ``IS NULL`` / ``IS NOT NULL`` form and the
# partial index stays drift-free against the migration.
_REFLECTION_SCOPE_COLUMN = Column("reflection_scope_key", String, nullable=True)
_DELETED_AT_COLUMN = Column("deleted_at", DateTime(timezone=True), nullable=True)

if TYPE_CHECKING:
    from .completion_suggestion import CompletionSuggestion
    from .marginalia import Marginalia
    from .promoted_quote import PromotedQuote
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
    # A reflection that closes a layer of the nested APTITUDE calendar (week,
    # stage, component, tier, or program). Carries a ``reflection_level`` /
    # ``reflection_scope_key`` pair pinning which layer it summarizes.
    HIERARCHICAL_REFLECTION = "hierarchical_reflection"


class EntryStatus(enum.StrEnum):
    """Lifecycle of a long-form journal entry, backing ``JournalEntry.status``.

    ``draft`` while being written; ``finished`` once committed.
    """

    DRAFT = "draft"
    FINISHED = "finished"


class JournalClassification(enum.StrEnum):
    """Privacy tier of a journal entry — "you choose your depth" (issue #894).

    ``public`` may be shared; ``personal`` is the default private tier;
    ``intimate`` is the most sensitive tier (issue #895 will keep intimate
    entries away from cloud LLMs). Stored as a plain string column with a DB
    CHECK so the persisted set can't drift from this enum.
    """

    PUBLIC = "public"
    PERSONAL = "personal"
    INTIMATE = "intimate"


def _classification_check() -> CheckConstraint:
    """CHECK derived from ``JournalClassification`` so the DB set can't drift."""
    quoted = ", ".join(f"'{c.value}'" for c in JournalClassification)
    return CheckConstraint(
        f"classification IN ({quoted})",
        name="ck_journalentry_classification_valid",
    )


def _reflection_level_check() -> CheckConstraint:
    """CHECK derived from ``ReflectionLevel`` so the DB set can't drift from the enum."""
    quoted = ", ".join(f"'{level.value}'" for level in ReflectionLevel)
    return CheckConstraint(
        f"reflection_level IS NULL OR reflection_level IN ({quoted})",
        name="ck_journalentry_reflection_level_valid",
    )


def _reflection_scope_paired_check() -> CheckConstraint:
    """CHECK that ``reflection_level`` and ``reflection_scope_key`` are set (or unset) together."""
    return CheckConstraint(
        "(reflection_level IS NULL) = (reflection_scope_key IS NULL)",
        name="ck_journalentry_reflection_scope_paired",
    )


def _aspect_range_check(column: str, name: str) -> CheckConstraint:
    """CHECK that ``column`` is NULL or a valid Aspect (1..``TOTAL_STAGES``).

    The bound is derived from ``TOTAL_STAGES`` so the persisted range can't
    drift from the curriculum length. The migration installs the identical SQL.
    """
    return CheckConstraint(
        f"{column} IS NULL OR {column} BETWEEN {ASPECT_MIN} AND {TOTAL_STAGES}",
        name=name,
    )


def _chord_shape_check() -> CheckConstraint:
    """CHECK that a secondary Aspect requires a distinct primary Aspect.

    A secondary tag is only meaningful atop a primary, and a chord's two notes
    must differ — so a secondary with no primary, or one equal to the primary,
    is rejected. The migration installs the identical SQL.
    """
    return CheckConstraint(
        "secondary_aspect IS NULL "
        "OR (primary_aspect IS NOT NULL AND secondary_aspect != primary_aspect)",
        name="ck_journalentry_chord_shape",
    )


class JournalEntry(SQLModel, table=True):
    """Stores a user's journal reflection, optionally paired with an AI resonance response.

    A ``sender`` of ``'bot'`` marks an AI resonance reply rather than a chat turn.

    Supports context tagging for stage reflections, practice notes, and
    habit-related thoughts.

    BUG-JOURNAL-007: hard delete is replaced with a soft-delete ``deleted_at``
    column so deleted rows can be recovered within the retention window and the
    ``LLMUsageLog.journal_entry_id`` FK is never orphaned.  All read endpoints
    filter ``deleted_at IS NULL``; soft-deleted rows are retained indefinitely.
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
        _classification_check(),
        _aspect_range_check("primary_aspect", "ck_journalentry_primary_aspect_range"),
        _aspect_range_check("secondary_aspect", "ck_journalentry_secondary_aspect_range"),
        _chord_shape_check(),
        _reflection_level_check(),
        _reflection_scope_paired_check(),
        # At most one *live* entry may hold a given (user, scope) coordinate: a
        # partial unique index over live rows (``deleted_at IS NULL``) that
        # excludes NULL scopes, so soft-deleting an entry frees its scope for
        # reuse and freeform (scopeless) entries never collide. Both dialects
        # render the same predicate; the migration installs the identical index.
        Index(
            "ix_journalentry_user_reflection_scope",
            "user_id",
            "reflection_scope_key",
            unique=True,
            postgresql_where=and_(
                _REFLECTION_SCOPE_COLUMN.is_not(None),
                _DELETED_AT_COLUMN.is_(None),
            ),
            sqlite_where=and_(
                _REFLECTION_SCOPE_COLUMN.is_not(None),
                _DELETED_AT_COLUMN.is_(None),
            ),
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    timestamp: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    # Encrypted at rest via EncryptedString (audit-destub-05b). No Field
    # max_length here (it can't coexist with sa_column, and ciphertext exceeds
    # the plaintext so the column is Text): the 10k input cap is enforced at the
    # write boundary by JournalMessageCreate
    # (max_length=JOURNAL_MESSAGE_MAX_LENGTH) plus the router's sanitizer.
    message: str = Field(sa_column=Column(EncryptedString(), nullable=False))
    # Long-form page metadata: an optional title and a draft/finished lifecycle.
    # ``message`` remains the body. ``updated_at`` tracks the last edit.
    title: str | None = Field(default=None, max_length=JOURNAL_TITLE_MAX_LENGTH)
    status: str = Field(default=EntryStatus.DRAFT, max_length=20)
    # Privacy tier; defaults to ``personal``. The DB CHECK in ``__table_args__``
    # pins the persisted value to the JournalClassification set.
    classification: str = Field(default=JournalClassification.PERSONAL, max_length=20)
    # Chord tagging: an optional primary Aspect (a stage 1..TOTAL_STAGES) and an
    # optional secondary. The CHECKs in ``__table_args__`` pin both to the valid
    # range and enforce the chord shape (a secondary requires a distinct primary).
    primary_aspect: int | None = Field(default=None)
    secondary_aspect: int | None = Field(default=None)
    sender: str = Field(max_length=10)  # 'user' or 'bot'
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    tag: str = Field(default=JournalTag.FREEFORM, max_length=50)
    # Hierarchical-reflection scope: which calendar layer this entry closes and
    # its ``c{cycle}:{token}`` key. The paired CHECK keeps the two in lock-step.
    reflection_level: str | None = Field(default=None, max_length=20)
    reflection_scope_key: str | None = Field(default=None, max_length=30)
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
    suggestions: list["CompletionSuggestion"] = Relationship(
        back_populates="entry",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )
    # ``PromotedQuote`` carries two FKs back to ``journalentry`` (its source and,
    # optionally, the entry it was later folded into); this relationship binds
    # only the source side, so ``foreign_keys`` is required to disambiguate.
    promoted_quotes: list["PromotedQuote"] = Relationship(
        back_populates="source_entry",
        sa_relationship_kwargs={
            "cascade": "all, delete-orphan",
            "foreign_keys": "PromotedQuote.source_entry_id",
        },
    )
