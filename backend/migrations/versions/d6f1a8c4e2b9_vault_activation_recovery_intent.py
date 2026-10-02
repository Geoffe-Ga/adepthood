"""Distinguish managed recovery cleanup from account-erasure teardown.

Revision ID: d6f1a8c4e2b9
Revises: c4e6a8b0d2f1
Create Date: 2026-10-01 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d6f1a8c4e2b9"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "c4e6a8b0d2f1"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "vaultactivation"
_COLUMN = "recovery_requested_at"


def upgrade() -> None:
    """Add a nullable, content-free marker for user-requested recovery."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.add_column(sa.Column(_COLUMN, sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    """Remove the recovery-intent marker without touching activation rows."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_column(_COLUMN)
