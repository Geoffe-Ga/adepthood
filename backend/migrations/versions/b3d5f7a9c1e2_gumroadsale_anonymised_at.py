"""Add ``gumroadsale.anonymised_at``, the sale receipt's retention clock (#3063 AC15).

Revision ID: b3d5f7a9c1e2
Revises: a7c9e1f3b5d8
Create Date: 2026-10-13 00:00:00.000000

The owner ratified the purchase receipt's lifetime on 2026-10-13: at account
deletion, blank the buyer's ``email`` and ``raw_payload`` on every sale linked to
the account and keep the receipt, then retain it 180 days after that instant.
The row recorded no such instant, so this revision adds one. Account deletion
stamps it; a sale never linked to an account is never stamped.

Purely additive and nullable, with no backfill: before this revision no sale was
ever anonymised, so ``NULL`` ("the clock has not started") is the truth for every
existing row. ``batch_alter_table`` keeps the SQLite round trip working.
``downgrade`` drops the column; the receipts stay.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b3d5f7a9c1e2"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "a7c9e1f3b5d8"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "gumroadsale"
_COLUMN = "anonymised_at"


def upgrade() -> None:
    """Add the nullable, timezone-aware anonymisation stamp."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.add_column(sa.Column(_COLUMN, sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    """Drop the stamp; no sale row is removed."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_column(_COLUMN)
