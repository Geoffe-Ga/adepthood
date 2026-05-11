"""add practicesession mode + mode_metadata + completed + insight

Revision ID: f0a1b2c3d4e5
Revises: e9f0a1b2c3d4
Create Date: 2026-05-11 10:00:00.000000

Adds four columns to ``practicesession`` for the ritual-04 mode-aware
session log:

* ``mode`` (VARCHAR(32), NOT NULL) — denormalized resolved practice mode
  at session time.  Backfilled to ``'meditation_timer'`` because every
  pre-existing row predates the per-mode engine and was effectively a
  plain countdown.
* ``mode_metadata`` (JSON, NULL) — engine-specific outputs (rep count,
  bpm used, tarot card index, …).  Left ``NULL`` on backfill so historical
  rows are clearly distinguishable from "explicitly empty".
* ``completed`` (BOOLEAN, NOT NULL, default TRUE) — whether the user
  reached the target.  Backfilled to ``TRUE`` since the legacy POST had
  no abort path.
* ``insight`` (VARCHAR(2000), NULL) — short user-captured takeaway,
  distinct from the long-form ``reflection`` column.

The two NOT-NULL columns are added nullable, backfilled, then locked
down inside a single ``batch_alter_table`` block so SQLite (used by the
round-trip test) rebuilds the table once.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f0a1b2c3d4e5"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "e9f0a1b2c3d4"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_DEFAULT_MODE = "meditation_timer"


def upgrade() -> None:
    """Add the four columns, backfill, then lock NOT-NULL constraints."""
    op.add_column(
        "practicesession",
        sa.Column("mode", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "practicesession",
        sa.Column("mode_metadata", sa.JSON(), nullable=True),
    )
    op.add_column(
        "practicesession",
        sa.Column("completed", sa.Boolean(), nullable=True),
    )
    op.add_column(
        "practicesession",
        sa.Column("insight", sa.String(length=2_000), nullable=True),
    )

    # Backfill every pre-existing row with the documented defaults.  We
    # leave ``mode_metadata`` and ``insight`` NULL on purpose so historical
    # rows stay distinguishable from "explicitly empty payload".
    op.execute(
        sa.text("UPDATE practicesession SET mode = :mode WHERE mode IS NULL").bindparams(
            mode=_DEFAULT_MODE
        )
    )
    op.execute(sa.text("UPDATE practicesession SET completed = TRUE WHERE completed IS NULL"))

    # Lock down NOT-NULL for ``mode`` and ``completed``.  batch_alter_table
    # groups the ALTERs so SQLite rebuilds the table once.
    with op.batch_alter_table("practicesession") as batch_op:
        batch_op.alter_column("mode", existing_type=sa.String(length=32), nullable=False)
        batch_op.alter_column("completed", existing_type=sa.Boolean(), nullable=False)


def downgrade() -> None:
    """Drop the four added columns."""
    with op.batch_alter_table("practicesession") as batch_op:
        batch_op.drop_column("insight")
        batch_op.drop_column("completed")
        batch_op.drop_column("mode_metadata")
        batch_op.drop_column("mode")
