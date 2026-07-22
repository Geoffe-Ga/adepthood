"""Add habit.is_carryover pre-program flag.

Revision ID: c2d3e4f5a6b7
Revises: d9e0f1a2b3c4
Create Date: 2026-07-10 00:00:00.000000

Adds ``is_carryover`` to ``habit``: ``True`` marks a habit the user brought into
APTITUDE from before the program (tracked on its own "negative lap" partition),
``False`` a regular program habit. ``upgrade`` adds it NOT NULL with a temporary
``server_default=false`` so existing rows can be inserted, then drops the DB
server default so the app owns the default via the model's ``Field`` default
(keeping ``alembic check`` drift-free). Existing rows stay ``False`` — accounts
predating this feature keep every habit on the program partition. ``downgrade``
drops the column.

The column is added and the default dropped inside ``batch_alter_table`` so the
SQLite round-trip test stays compatible with the Postgres prod target.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c2d3e4f5a6b7"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "d9e0f1a2b3c4"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add ``is_carryover`` (NOT NULL, default False), then drop the server default."""
    # Add with a server_default so the NOT NULL column can be added to a table
    # that already has rows; existing habits stay on the program partition.
    op.add_column(
        "habit",
        sa.Column("is_carryover", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    # Drop the DB-level server_default (the app owns the default via the model's
    # Field default, keeping ``alembic check`` drift-free). Batch mode keeps the
    # ALTER SQLite-compatible for the round-trip test.
    with op.batch_alter_table("habit") as batch_op:
        batch_op.alter_column(
            "is_carryover",
            existing_type=sa.Boolean(),
            existing_nullable=False,
            server_default=None,
        )


def downgrade() -> None:
    """Drop the is_carryover column."""
    # Batch mode keeps the downgrade SQLite-compatible.
    with op.batch_alter_table("habit") as batch_op:
        batch_op.drop_column("is_carryover")
