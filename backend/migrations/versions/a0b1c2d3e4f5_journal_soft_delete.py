"""add deleted_at soft-delete column to journalentry

Revision ID: a0b1c2d3e4f5
Revises: f0a1b2c3d4e5
Create Date: 2026-05-11 12:00:00.000000

BUG-JOURNAL-007: replaces hard-delete semantics with a soft-delete column so
deleted journal entries can be recovered within the retention window and the
``LLMUsageLog.journal_entry_id`` FK reference is never orphaned.

The column is nullable (``NULL`` = live row, non-NULL = soft-deleted timestamp).
All read paths in ``routers/journal.py`` and ``services/journal.py`` filter
``deleted_at IS NULL`` so soft-deleted rows are invisible to API consumers.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a0b1c2d3e4f5"  # pragma: allowlist secret
down_revision: Union[str, None] = "f0a1b2c3d4e5"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add nullable ``deleted_at`` column to ``journalentry``."""
    with op.batch_alter_table("journalentry", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "deleted_at",
                sa.DateTime(timezone=True),
                nullable=True,
                server_default=None,
            )
        )
        batch_op.create_index(
            "ix_journalentry_deleted_at",
            ["deleted_at"],
            unique=False,
        )


def downgrade() -> None:
    """Remove the ``deleted_at`` column from ``journalentry``."""
    with op.batch_alter_table("journalentry", schema=None) as batch_op:
        batch_op.drop_index("ix_journalentry_deleted_at")
        batch_op.drop_column("deleted_at")
