"""add journalentry document fields: title, status, updated_at

Revision ID: d4c3b2a1f6e5
Revises: f6e5d4c3b2a1
Create Date: 2026-06-27 00:00:00.000000

Evolves a journal entry from a discrete chat message into a long-form page:
``title`` (optional), ``status`` (draft|finished), and ``updated_at``. Columns
are added nullable, existing rows are backfilled (status='finished' since they
predate the draft workflow; updated_at = the original timestamp), then status and
updated_at are tightened to NOT NULL to match the model. ``downgrade`` drops them.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d4c3b2a1f6e5"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "f6e5d4c3b2a1"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add title/status/updated_at, backfill existing rows, tighten NOT NULL."""
    op.add_column("journalentry", sa.Column("title", sa.String(length=200), nullable=True))
    op.add_column("journalentry", sa.Column("status", sa.String(length=20), nullable=True))
    op.add_column(
        "journalentry",
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Existing rows predate the draft workflow, so they are finished pages; their
    # last-edit time is best approximated by the original timestamp.
    op.execute("UPDATE journalentry SET status = 'finished' WHERE status IS NULL")
    # ``"timestamp"`` is quoted to read unambiguously as the column (not the SQL
    # type keyword / CURRENT_TIMESTAMP).
    op.execute('UPDATE journalentry SET updated_at = "timestamp" WHERE updated_at IS NULL')
    with op.batch_alter_table("journalentry") as batch:
        batch.alter_column("status", existing_type=sa.String(length=20), nullable=False)
        batch.alter_column("updated_at", existing_type=sa.DateTime(timezone=True), nullable=False)


def downgrade() -> None:
    """Drop the document fields."""
    op.drop_column("journalentry", "updated_at")
    op.drop_column("journalentry", "status")
    op.drop_column("journalentry", "title")
