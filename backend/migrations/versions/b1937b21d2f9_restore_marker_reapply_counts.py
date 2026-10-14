"""Record the obligation and Intimate reapply counts on the restore marker (#3237).

Revision ID: b1937b21d2f9
Revises: e0094da08afc
Create Date: 2026-10-14 00:00:00.000000

Tombstone format v3 (#3214) re-applies owed withdrawals and Intimate re-stamps,
and the reapply receipt reports both counts. ``restoremarker`` is the durable,
content-free record of a restore, so it gains two non-negative integer columns
for them: ``obligations_reapplied`` and ``intimate_reapplied``.

Purely additive. Existing markers are backfilled to 0, which is the truth for
every reapply that ran before v3 existed (it re-applied neither). The
server default is temporary: the model owns the default, so the DB-level one is
cleared straight after, or ``alembic check`` reports drift. ``downgrade`` drops
the CHECK and both columns, losing only these two counts.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b1937b21d2f9"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "e0094da08afc"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "restoremarker"
_COLUMNS = ("obligations_reapplied", "intimate_reapplied")
_CHECK = "ck_restoremarker_reapply_counts_range"
_CONDITION = "obligations_reapplied >= 0 AND intimate_reapplied >= 0"
_BACKFILL = "0"


def upgrade() -> None:
    """Add both counts backfilled to 0, then clear the default and add the range CHECK."""
    for name in _COLUMNS:
        op.add_column(
            _TABLE,
            sa.Column(name, sa.Integer(), nullable=False, server_default=_BACKFILL),
        )
    # One batch block, so SQLite (the round-trip test) rebuilds the table to take
    # the CHECK and the default change, and PostgreSQL emits plain ALTERs.
    with op.batch_alter_table(_TABLE) as batch_op:
        for name in _COLUMNS:
            batch_op.alter_column(
                name,
                existing_type=sa.Integer(),
                existing_nullable=False,
                server_default=None,
            )
        batch_op.create_check_constraint(_CHECK, _CONDITION)


def downgrade() -> None:
    """Drop the CHECK and both counts; no other column changes."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_constraint(_CHECK, type_="check")
        for name in reversed(_COLUMNS):
            batch_op.drop_column(name)
