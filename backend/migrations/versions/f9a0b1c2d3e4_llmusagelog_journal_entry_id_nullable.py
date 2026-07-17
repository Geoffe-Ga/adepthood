"""make llmusagelog.journal_entry_id nullable for stateless metered calls.

Revision ID: f9a0b1c2d3e4
Revises: c7d8e9f0a1b3
Create Date: 2026-07-17 00:00:00.000000

The single-page journal-transcription endpoint meters a real LLM call that has
no associated journal entry, so ``journal_entry_id`` must accept ``NULL``. This
is a backward-compatible widening: every existing row already carries a real
entry id, so relaxing the NOT NULL constraint invalidates nothing.

The change is wrapped in ``batch_alter_table`` so the SQLite round-trip test
rebuilds the table while Postgres emits a plain ``ALTER COLUMN``.

The downgrade is intentionally lossy: rows written by a stateless call have no
entry to point at, so restoring NOT NULL requires deleting the ``NULL`` rows
first. Those rows are cost-audit records only, never user content, and the
usage log is append-only, so the delete cannot cascade into anything else.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f9a0b1c2d3e4"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "c7d8e9f0a1b3"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE_NAME = "llmusagelog"
_COLUMN_NAME = "journal_entry_id"


def upgrade() -> None:
    """Relax ``journal_entry_id`` to nullable so stateless calls can be metered."""
    with op.batch_alter_table(_TABLE_NAME) as batch_op:
        batch_op.alter_column(_COLUMN_NAME, existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    """Restore NOT NULL, deleting the entry-less rows first (intentionally lossy)."""
    op.execute(f"DELETE FROM {_TABLE_NAME} WHERE {_COLUMN_NAME} IS NULL")
    with op.batch_alter_table(_TABLE_NAME) as batch_op:
        batch_op.alter_column(_COLUMN_NAME, existing_type=sa.Integer(), nullable=False)
