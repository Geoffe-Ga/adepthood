"""Add the shared revocation claim column to gumroadsale.

Revision ID: d5e6f7a8b9c0
Revises: b8c9d0e1f2a3
Create Date: 2026-07-24 00:00:00.000000

Issue #1945: a Gumroad refund, dispute, cancellation, or subscription-ended
ping unwinds the original sale exactly once. ``revocation_processed_at`` is
the single claim guard every one of those events competes for, taken with a
guarded ``UPDATE ... WHERE revocation_processed_at IS NULL``. One column
rather than one per event kind is deliberate: a cancelled subscription that
is later refunded has nothing left to revoke, and the loser of the race must
see that in the data.

Purely additive. Every pre-existing row lands ``NULL``, i.e. unreversed —
which is correct: no reversal has ever been processed, because this change is
the first handler for those event types.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d5e6f7a8b9c0"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "b8c9d0e1f2a3"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "gumroadsale"
_REVOCATION_COLUMN = "revocation_processed_at"


def upgrade() -> None:
    """Add the nullable, timezone-aware revocation claim column."""
    # Batch mode keeps this SQLite-safe (table rebuild) while emitting a plain
    # ALTER on Postgres, which is what production runs.
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.add_column(
            sa.Column(_REVOCATION_COLUMN, sa.DateTime(timezone=True), nullable=True)
        )


def downgrade() -> None:
    """Drop the revocation claim column."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_column(_REVOCATION_COLUMN)
