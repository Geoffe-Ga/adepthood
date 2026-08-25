"""add accountdeletionaudit table

Revision ID: c2d3e4f5a6b8
Revises: c1d2e3f4a5b7
Create Date: 2026-08-14 00:00:00.000000

Adds ``accountdeletionaudit`` — one row per completed in-app account deletion,
so that "did this account's erasure actually run, when, and how far did it
reach?" has an answer after every row it refers to is gone.

The table stores the surrogate ``user_id`` (now naming nobody), the instant, a
total, a per-table row-count map, and the vault disposition. It stores no
column values from the erased rows: journal bodies are encrypted at rest, and
copying any of them — or the account's email — into an unencrypted side table
would recreate exactly what the erasure removed.

``user_id`` carries **no** foreign key on purpose. The row it names has been
deleted by the time this one is written, so a constraint would either block the
deletion or take the receipt down with it.

``downgrade`` drops the table.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c2d3e4f5a6b8"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "c1d2e3f4a5b7"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE_NAME = "accountdeletionaudit"
_USER_INDEX = "ix_accountdeletionaudit_user_id"
_DELETED_AT_INDEX = "ix_accountdeletionaudit_deleted_at"

# Matches the model's ``_DISPOSITION_COLUMN_WIDTH``: a short symbolic token
# (``not_purged``), never prose.
_DISPOSITION_WIDTH = 32


def upgrade() -> None:
    """Create the deletion-receipt table and its two lookup indexes."""
    op.create_table(
        _TABLE_NAME,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column(
            "deleted_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("rows_erased", sa.Integer(), nullable=False),
        sa.Column("row_counts", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("vault_disposition", sa.String(length=_DISPOSITION_WIDTH), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(_USER_INDEX, _TABLE_NAME, ["user_id"])
    op.create_index(_DELETED_AT_INDEX, _TABLE_NAME, ["deleted_at"])


def downgrade() -> None:
    """Drop the deletion-receipt table and its indexes."""
    op.drop_index(_DELETED_AT_INDEX, table_name=_TABLE_NAME)
    op.drop_index(_USER_INDEX, table_name=_TABLE_NAME)
    op.drop_table(_TABLE_NAME)
