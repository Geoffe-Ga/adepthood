"""add corpusfragment table

Revision ID: c3d4e5f6a7b9
Revises: c2d3e4f5a6b8
Create Date: 2026-08-21 00:00:00.000000

Adds ``corpusfragment`` — one row per classified piece of an account's own
writing, which is the storage layer the day-one ontology epic (#2228) is built
on. Each row carries the account it belongs to, where the fragment came from,
its privacy tier, the encrypted text, the per-frequency weights the classifier
produced, and an optional embedding.

``ck_corpusfragment_tier_retrievable`` is the load-bearing constraint. The
intimate tier is absent from its permitted set on purpose (ADR 0005 Decision
2): a fragment of intimate writing is not a row that exists and is then
filtered out of reads, it is a row this table refuses to hold. Relaxing that
constraint — including with a ``NOT VALID`` window in some later migration —
changes a privacy guarantee, not a validation rule.

``embedding`` is a plain float array rather than a pgvector column. Retrieval
ranks a bounded candidate pool in process, so no ANN index is consulted, and an
extension-typed column would be unusable under the SQLite database the ranking
assertions run against.

``downgrade`` drops the table and its indexes.
"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "c3d4e5f6a7b9"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "c2d3e4f5a6b8"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE_NAME = "corpusfragment"
_USER_INDEX = "ix_corpusfragment_user_id"
_RETRIEVAL_INDEX = "ix_corpusfragment_user_tier_created"

# Matches the model's ``_TIER_WIDTH`` / ``_SOURCE_WIDTH``: both columns hold one
# symbolic token from a closed set, never prose.
_TIER_WIDTH = 20
_SOURCE_WIDTH = 20


def upgrade() -> None:
    """Create the corpus table, its two indexes and its three CHECKs."""
    op.create_table(
        _TABLE_NAME,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("source", sqlmodel.sql.sqltypes.AutoString(length=_SOURCE_WIDTH), nullable=False),
        sa.Column("tier", sqlmodel.sql.sqltypes.AutoString(length=_TIER_WIDTH), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("frequency_weights", sa.JSON(), nullable=False),
        sa.Column("overall_confidence", sa.Float(), nullable=False),
        sa.Column("embedding", postgresql.ARRAY(sa.Float()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "tier IN ('public', 'personal')",
            name="ck_corpusfragment_tier_retrievable",
        ),
        sa.CheckConstraint(
            "source IN ('journal', 'upload', 'import')",
            name="ck_corpusfragment_source_valid",
        ),
        sa.CheckConstraint(
            "overall_confidence BETWEEN 0.0 AND 1.0",
            name="ck_corpusfragment_confidence_range",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(_USER_INDEX, _TABLE_NAME, ["user_id"])
    op.create_index(_RETRIEVAL_INDEX, _TABLE_NAME, ["user_id", "tier", "created_at"])


def downgrade() -> None:
    """Drop the corpus table and its indexes."""
    op.drop_index(_RETRIEVAL_INDEX, table_name=_TABLE_NAME)
    op.drop_index(_USER_INDEX, table_name=_TABLE_NAME)
    op.drop_table(_TABLE_NAME)
