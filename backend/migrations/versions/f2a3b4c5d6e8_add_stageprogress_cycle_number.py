"""Add stageprogress.cycle_number loop index.

Revision ID: f2a3b4c5d6e8
Revises: e2f3a4b5c6d8
Create Date: 2026-07-01 00:00:00.000000

Adds the loop-index column ``cycle_number`` to ``stageprogress``. ``upgrade``
adds it ``NOT NULL`` with a temporary ``server_default='1'`` so existing rows
backfill to the first cycle, then drops the server default (the app owns the
default via the model's ``Field`` default, keeping ``alembic check`` drift-free),
then installs a CHECK pinning the value to ``>= 1`` — mirroring the constraint
in the model's ``__table_args__``. ``downgrade`` drops the CHECK and the column.
This is a data-model change only; the progression/loop behaviour lands in a
later issue.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f2a3b4c5d6e8"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "e2f3a4b5c6d8"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CYCLE_CHECK = "ck_stageprogress_cycle_number_positive"
_CYCLE_CONDITION = "cycle_number >= 1"


def upgrade() -> None:
    """Add ``stageprogress.cycle_number`` (NOT NULL, backfilled 1) + CHECK."""
    # Add with a server_default so the NOT NULL column backfills existing rows to
    # the first cycle (1).
    op.add_column(
        "stageprogress",
        sa.Column(
            "cycle_number",
            sa.Integer(),
            nullable=False,
            server_default="1",
        ),
    )
    # Drop the DB-level server_default (the app owns the default via the model's
    # Field default, keeping ``alembic check`` drift-free) and install the CHECK
    # in a single batch rebuild so SQLite (round-trip test) stays compatible.
    with op.batch_alter_table("stageprogress") as batch_op:
        batch_op.alter_column(
            "cycle_number",
            existing_type=sa.Integer(),
            existing_nullable=False,
            server_default=None,
        )
        batch_op.create_check_constraint(_CYCLE_CHECK, _CYCLE_CONDITION)


def downgrade() -> None:
    """Drop the cycle_number CHECK and column."""
    # Batch mode keeps the downgrade SQLite-compatible (no ALTER/DROP CHECK there).
    with op.batch_alter_table("stageprogress") as batch_op:
        batch_op.drop_constraint(_CYCLE_CHECK, type_="check")
        batch_op.drop_column("cycle_number")
