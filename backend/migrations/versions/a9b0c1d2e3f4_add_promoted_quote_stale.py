"""Add promotedquote.stale re-anchor flag.

Revision ID: a9b0c1d2e3f4
Revises: c4f7a2b8d9e1
Create Date: 2026-07-07 00:00:00.000000

Adds ``stale`` to ``promotedquote``: set True when a source journal entry's body
is edited such that a pending quote's anchored passage is deleted or mutated and
can no longer be re-anchored. A stale quote is never revived or deleted — it
stays for the user to resolve (mirrors ``Marginalia``). ``upgrade`` adds the
column NOT NULL with a temporary ``server_default=false`` so it can be added to a
table that already has rows, then drops the DB server default so the app owns the
default via the model's ``Field`` default (keeping ``alembic check`` drift-free).
``downgrade`` drops the column.

The column is added and the default dropped inside ``batch_alter_table`` so the
SQLite round-trip test stays compatible with the Postgres prod target.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a9b0c1d2e3f4"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "c4f7a2b8d9e1"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add ``stale`` (NOT NULL, default False), then drop the DB server default."""
    # Add with a server_default so the NOT NULL column can be added to a table
    # that already has rows (each existing quote starts not-stale).
    op.add_column(
        "promotedquote",
        sa.Column("stale", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    # Drop the DB-level server_default (the app owns the default via the model's
    # Field default, keeping ``alembic check`` drift-free). Batch mode keeps the
    # ALTER SQLite-compatible for the round-trip test.
    with op.batch_alter_table("promotedquote") as batch_op:
        batch_op.alter_column(
            "stale",
            existing_type=sa.Boolean(),
            existing_nullable=False,
            server_default=None,
        )


def downgrade() -> None:
    """Drop the stale column."""
    # Batch mode keeps the downgrade SQLite-compatible.
    with op.batch_alter_table("promotedquote") as batch_op:
        batch_op.drop_column("stale")
