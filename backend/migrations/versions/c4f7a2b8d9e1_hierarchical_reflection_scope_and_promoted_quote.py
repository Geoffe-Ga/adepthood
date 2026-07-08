"""Add hierarchical reflection scope to journalentry and the promotedquote table.

Revision ID: c4f7a2b8d9e1
Revises: f7a8b9c0d1e3
Create Date: 2026-07-08 00:00:00.000000

Backs the hierarchical-journaling data layer (issue #1460):

* Two nullable columns on ``journalentry`` -- ``reflection_level`` and
  ``reflection_scope_key`` -- plus a CHECK pinning the level to the
  ReflectionLevel set, a paired CHECK keeping the two columns in lock-step, and
  a partial unique index enforcing at most one *live* entry per
  ``(user_id, reflection_scope_key)`` coordinate (NULL scopes excluded, soft-
  deleted rows excluded).
* A new ``promotedquote`` table holding one row per quote a user lifted from a
  source entry, with anchor-bound CHECKs and two FKs back to ``journalentry``
  (its source, CASCADE, and the entry it was folded into, SET NULL).

A migration is a frozen historical snapshot and must be self-contained: it
cannot import live application code (``domain.reflection_hierarchy``,
``services.journal_encryption``), so the level list is inlined and the encrypted
text column is declared as a plain ``sa.Text``. The CHECK/index names and SQL
below are IDENTICAL to the model's ``__table_args__`` so ``alembic check`` sees
no drift. Both dialects get ``postgresql_where`` and ``sqlite_where`` on the
partial index for the same reason. ``upgrade`` adds the columns, CHECKs, index,
and table; ``downgrade`` reverses them in order.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c4f7a2b8d9e1"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "f7a8b9c0d1e3"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_JOURNAL_TABLE = "journalentry"
_QUOTE_TABLE = "promotedquote"

_LEVEL_CHECK = "ck_journalentry_reflection_level_valid"
_SCOPE_PAIRED_CHECK = "ck_journalentry_reflection_scope_paired"
_SCOPE_INDEX = "ix_journalentry_user_reflection_scope"

# Inlined literals mirroring the model. ``_LEVEL_CONDITION`` lists the
# ReflectionLevel values as of this revision; ``_SCOPE_PREDICATE`` is the partial
# index's WHERE clause, identical for both dialects.
_LEVEL_CONDITION = (
    "reflection_level IS NULL "
    "OR reflection_level IN ('week', 'stage', 'component', 'tier', 'program')"
)
_SCOPE_PAIRED_CONDITION = "(reflection_level IS NULL) = (reflection_scope_key IS NULL)"
_SCOPE_PREDICATE = "reflection_scope_key IS NOT NULL AND deleted_at IS NULL"

_QUOTE_SOURCE_INDEX = "ix_promotedquote_source_entry_id"
_QUOTE_USER_INCLUDED_INDEX = "ix_promotedquote_user_included"
_QUOTE_START_CHECK = "ck_promotedquote_anchor_start_nonneg"
_QUOTE_SPAN_CHECK = "ck_promotedquote_anchor_span_positive"


def upgrade() -> None:
    """Add the reflection-scope columns, CHECKs, and index, then create promotedquote."""
    op.add_column(
        _JOURNAL_TABLE,
        sa.Column("reflection_level", sa.String(length=20), nullable=True),
    )
    op.add_column(
        _JOURNAL_TABLE,
        sa.Column("reflection_scope_key", sa.String(length=30), nullable=True),
    )
    # Install the CHECKs in a single batch rebuild so SQLite (round-trip test)
    # stays compatible.
    with op.batch_alter_table(_JOURNAL_TABLE) as batch_op:
        batch_op.create_check_constraint(_LEVEL_CHECK, _LEVEL_CONDITION)
        batch_op.create_check_constraint(_SCOPE_PAIRED_CHECK, _SCOPE_PAIRED_CONDITION)
    op.create_index(
        _SCOPE_INDEX,
        _JOURNAL_TABLE,
        ["user_id", "reflection_scope_key"],
        unique=True,
        postgresql_where=sa.text(_SCOPE_PREDICATE),
        sqlite_where=sa.text(_SCOPE_PREDICATE),
    )

    op.create_table(
        _QUOTE_TABLE,
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("source_entry_id", sa.Integer(), nullable=False),
        sa.Column("anchor_start", sa.Integer(), nullable=False),
        sa.Column("anchor_end", sa.Integer(), nullable=False),
        sa.Column("anchor_text", sa.Text(), nullable=False),
        sa.Column("included_in_entry_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_entry_id"], ["journalentry.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["included_in_entry_id"],
            ["journalentry.id"],
            ondelete="SET NULL",
        ),
        sa.CheckConstraint("anchor_start >= 0", name=_QUOTE_START_CHECK),
        sa.CheckConstraint("anchor_end > anchor_start", name=_QUOTE_SPAN_CHECK),
    )
    op.create_index(_QUOTE_SOURCE_INDEX, _QUOTE_TABLE, ["source_entry_id"])
    op.create_index(_QUOTE_USER_INCLUDED_INDEX, _QUOTE_TABLE, ["user_id", "included_in_entry_id"])


def downgrade() -> None:
    """Drop promotedquote, the partial index, the CHECKs, and the reflection columns."""
    op.drop_index(_QUOTE_USER_INCLUDED_INDEX, table_name=_QUOTE_TABLE)
    op.drop_index(_QUOTE_SOURCE_INDEX, table_name=_QUOTE_TABLE)
    op.drop_table(_QUOTE_TABLE)

    op.drop_index(_SCOPE_INDEX, table_name=_JOURNAL_TABLE)
    with op.batch_alter_table(_JOURNAL_TABLE) as batch_op:
        batch_op.drop_constraint(_SCOPE_PAIRED_CHECK, type_="check")
        batch_op.drop_constraint(_LEVEL_CHECK, type_="check")
        batch_op.drop_column("reflection_scope_key")
        batch_op.drop_column("reflection_level")
