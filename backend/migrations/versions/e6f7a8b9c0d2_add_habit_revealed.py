"""Add habit.revealed unlock flag.

Revision ID: e6f7a8b9c0d2
Revises: d3e4f5a6b7c8
Create Date: 2026-07-03 00:00:00.000000

Adds ``revealed`` to ``habit``: the single source of truth for whether a habit
is unlocked (``revealed is True`` == unlocked). ``upgrade`` adds it NOT NULL
with a temporary ``server_default=false`` so existing rows can be inserted,
then backfills every EXISTING row to ``true`` — accounts predating the
locked-by-default model keep their habits unlocked — and finally drops the DB
server default so the app owns the default via the model's ``Field`` default
(keeping ``alembic check`` drift-free). Only NEW/seeded habits created after
this migration start locked. ``downgrade`` drops the column.

The column is added and the default dropped inside ``batch_alter_table`` so the
SQLite round-trip test stays compatible with the Postgres prod target.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e6f7a8b9c0d2"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "d3e4f5a6b7c8"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add ``revealed`` (NOT NULL), backfill existing rows to unlocked, drop the default."""
    # Add with a server_default so the NOT NULL column can be added to a table
    # that already has rows, then backfill each existing habit to unlocked.
    op.add_column(
        "habit",
        sa.Column("revealed", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.execute("UPDATE habit SET revealed = true")
    # Drop the DB-level server_default (the app owns the default via the model's
    # Field default, keeping ``alembic check`` drift-free). Batch mode keeps the
    # ALTER SQLite-compatible for the round-trip test.
    with op.batch_alter_table("habit") as batch_op:
        batch_op.alter_column(
            "revealed",
            existing_type=sa.Boolean(),
            existing_nullable=False,
            server_default=None,
        )


def downgrade() -> None:
    """Drop the revealed column."""
    # Batch mode keeps the downgrade SQLite-compatible.
    with op.batch_alter_table("habit") as batch_op:
        batch_op.drop_column("revealed")
