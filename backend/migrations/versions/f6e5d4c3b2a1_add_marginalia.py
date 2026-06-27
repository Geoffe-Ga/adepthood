"""add marginalia table for anchored AI margin notes

Revision ID: f6e5d4c3b2a1
Revises: b7c8d9e0f1a2
Create Date: 2026-06-27 00:00:00.000000

Purely additive: ``upgrade`` creates the ``marginalia`` table (margin notes
anchored to a character span of a journal entry) plus its FK index; ``downgrade``
drops them. No ``ALTER`` / ``DROP`` against existing tables. The ``journal_entry_id``
FK cascades so deleting a journal entry removes its marginalia.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f6e5d4c3b2a1"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "b7c8d9e0f1a2"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create the ``marginalia`` table and its FK index."""
    op.create_table(
        "marginalia",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("journal_entry_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("anchor_start", sa.Integer(), nullable=False),
        sa.Column("anchor_end", sa.Integer(), nullable=False),
        sa.Column("anchor_text", sa.String(length=280), nullable=False),
        sa.Column("note", sa.String(length=600), nullable=False),
        sa.Column("essay", sa.String(length=10000), nullable=True),
        sa.Column("essay_generated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["journal_entry_id"], ["journalentry.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_marginalia_journal_entry_id", "marginalia", ["journal_entry_id"])


def downgrade() -> None:
    """Drop the ``marginalia`` table and its index."""
    op.drop_index("ix_marginalia_journal_entry_id", table_name="marginalia")
    op.drop_table("marginalia")
