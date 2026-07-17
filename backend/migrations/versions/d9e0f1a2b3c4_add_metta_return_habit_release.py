"""add metta_return_habit_release table for per-arc habit release records.

Revision ID: d9e0f1a2b3c4
Revises: f9a0b1c2d3e4
Create Date: 2026-07-17 00:00:00.000000

Purely additive: ``upgrade`` creates the ``mettareturnhabitrelease`` table (one
row per habit a user released during a Return arc) with its cascading owner,
arc, and habit foreign keys, the ``(arc_id, habit_id)`` unique constraint that
makes a release idempotent within its arc, and the non-unique arc index.
``downgrade`` drops the index then the table. No ``ALTER`` / ``DROP`` against
existing tables.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d9e0f1a2b3c4"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "f9a0b1c2d3e4"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the ``mettareturnhabitrelease`` table and its arc index."""
    op.create_table(
        "mettareturnhabitrelease",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("arc_id", sa.Integer(), nullable=False),
        sa.Column("habit_id", sa.Integer(), nullable=False),
        sa.Column("released_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("recommitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["arc_id"], ["mettareturnarc.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["habit_id"], ["habit.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "arc_id",
            "habit_id",
            name="uq_metta_return_habit_release_arc_habit",
        ),
    )
    op.create_index(
        "ix_metta_return_habit_release_arc_id",
        "mettareturnhabitrelease",
        ["arc_id"],
    )


def downgrade() -> None:
    """Drop the ``mettareturnhabitrelease`` arc index then the table."""
    op.drop_index(
        "ix_metta_return_habit_release_arc_id",
        table_name="mettareturnhabitrelease",
    )
    op.drop_table("mettareturnhabitrelease")
