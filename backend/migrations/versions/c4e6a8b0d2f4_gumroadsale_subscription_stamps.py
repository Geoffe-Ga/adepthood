"""Add the membership stamps to ``gumroadsale`` (#3259, cancel-timing).

Revision ID: c4e6a8b0d2f4
Revises: b1937b21d2f9
Create Date: 2026-10-14 00:00:00.000000

The owner decided cancel-timing on 2026-10-14: a ``cancellation`` ping changes
no access, ``subscription_ended`` restricts AI, and ``subscription_restarted``
gives it back. A cancellation therefore no longer spends the sale's one-time
reversal claim, so the membership's state needs columns of its own:

* ``subscription_cancelled_at`` -- the audit stamp of the first cancellation.
* ``subscription_ended_at`` / ``subscription_restarted_at`` -- the latest event
  time of each kind; whichever is later decides whether the membership ended.

Purely additive and nullable, with no backfill: no membership event was ever
recorded this way before this revision, so ``NULL`` is the truth for every
existing row. ``batch_alter_table`` keeps the SQLite round trip working.
``downgrade`` drops the three columns; the sales stay.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c4e6a8b0d2f4"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "b1937b21d2f9"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "gumroadsale"
_COLUMNS = (
    "subscription_cancelled_at",
    "subscription_ended_at",
    "subscription_restarted_at",
)


def upgrade() -> None:
    """Add the three nullable, timezone-aware membership stamps."""
    with op.batch_alter_table(_TABLE) as batch_op:
        for column in _COLUMNS:
            batch_op.add_column(sa.Column(column, sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    """Drop the stamps; no sale row is removed."""
    with op.batch_alter_table(_TABLE) as batch_op:
        for column in reversed(_COLUMNS):
            batch_op.drop_column(column)
