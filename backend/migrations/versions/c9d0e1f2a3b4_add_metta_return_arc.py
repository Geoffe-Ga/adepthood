"""add metta_return_arc table for the declinable Metta Return arc.

Revision ID: c9d0e1f2a3b4
Revises: b3c4d5e6f7a8
Create Date: 2026-07-01 00:00:00.000000

Purely additive: ``upgrade`` creates the ``mettareturnarc`` table (a user's
opt-in, penalty-free five-week Return arc) with its owner FK (cascading), the
partial unique index enforcing at most one active arc per user (``left_at IS
NULL``), and the non-unique owner index. ``downgrade`` drops the indexes then
the table. No ``ALTER`` / ``DROP`` against existing tables.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c9d0e1f2a3b4"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "b3c4d5e6f7a8"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the ``mettareturnarc`` table and its indexes."""
    op.create_table(
        "mettareturnarc",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("paused_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("left_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    # Partial unique index: at most one active arc (``left_at IS NULL``) per
    # user, while any number of previously-left arcs may coexist so leaving and
    # restarting is always allowed.
    op.create_index(
        "ix_metta_return_arc_user_active",
        "mettareturnarc",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("left_at IS NULL"),
        sqlite_where=sa.text("left_at IS NULL"),
    )
    op.create_index(
        "ix_metta_return_arc_user_id",
        "mettareturnarc",
        ["user_id"],
    )


def downgrade() -> None:
    """Drop the ``mettareturnarc`` indexes then the table."""
    op.drop_index("ix_metta_return_arc_user_id", table_name="mettareturnarc")
    op.drop_index("ix_metta_return_arc_user_active", table_name="mettareturnarc")
    op.drop_table("mettareturnarc")
