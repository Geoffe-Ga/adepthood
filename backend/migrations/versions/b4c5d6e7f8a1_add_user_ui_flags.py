"""add user_ui_flags table

Revision ID: b4c5d6e7f8a1
Revises: a9b0c1d2e3f4
Create Date: 2026-07-10 00:00:00.000000

Adds ``useruiflags`` — one row per user recording lightweight one-time UI
state (whether the welcome flow has been seen and whether the energy-scaffolding
surface has been archived). ``upgrade`` creates the table with both boolean
flags ``NOT NULL`` and a DB-level ``server_default`` of false (mirroring the
model's ``server_default`` so ``alembic check`` stays drift-free), and a unique
FK to ``user.id`` with ``ON DELETE CASCADE``. No rows are backfilled: existing
users are provisioned on their first read. ``downgrade`` drops the table.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b4c5d6e7f8a1"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "a9b0c1d2e3f4"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE_NAME = "useruiflags"


def upgrade() -> None:
    """Create ``useruiflags`` with both flags defaulting to false (no backfill)."""
    op.create_table(
        _TABLE_NAME,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("has_seen_welcome", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "energy_scaffolding_archived",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id"),
    )


def downgrade() -> None:
    """Drop the ``useruiflags`` table."""
    op.drop_table(_TABLE_NAME)
