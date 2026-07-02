"""Add journalentry chord aspects (primary + optional secondary).

Revision ID: a5b6c7d8e9f0
Revises: c9d0e1f2a3b4
Create Date: 2026-07-01 00:00:00.000000

Adds two nullable columns, ``primary_aspect`` and ``secondary_aspect``, plus the
range and chord-shape CHECKs mirroring the model's ``__table_args__``. ``upgrade``
adds the columns (nullable, no backfill needed) then installs the CHECKs in a
batch rebuild so SQLite (round-trip test) stays compatible. ``downgrade`` drops
the CHECKs then the columns.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from domain.constants import TOTAL_STAGES

# revision identifiers, used by Alembic.
revision: str = "a5b6c7d8e9f0"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "c9d0e1f2a3b4"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The inclusive lower bound of a valid Aspect; the upper bound is TOTAL_STAGES so
# the persisted range never drifts from the curriculum length. Conditions below
# are IDENTICAL to the model's ``__table_args__`` CHECKs.
_ASPECT_MIN = 1
_PRIMARY_RANGE_CHECK = "ck_journalentry_primary_aspect_range"
_SECONDARY_RANGE_CHECK = "ck_journalentry_secondary_aspect_range"
_CHORD_SHAPE_CHECK = "ck_journalentry_chord_shape"
_PRIMARY_RANGE_CONDITION = (
    f"primary_aspect IS NULL OR primary_aspect BETWEEN {_ASPECT_MIN} AND {TOTAL_STAGES}"
)
_SECONDARY_RANGE_CONDITION = (
    f"secondary_aspect IS NULL OR secondary_aspect BETWEEN {_ASPECT_MIN} AND {TOTAL_STAGES}"
)
_CHORD_SHAPE_CONDITION = (
    "secondary_aspect IS NULL "
    "OR (primary_aspect IS NOT NULL AND secondary_aspect != primary_aspect)"
)


def upgrade() -> None:
    """Add the two nullable chord columns + the range and chord-shape CHECKs."""
    op.add_column("journalentry", sa.Column("primary_aspect", sa.Integer(), nullable=True))
    op.add_column("journalentry", sa.Column("secondary_aspect", sa.Integer(), nullable=True))
    # Install the CHECKs in a single batch rebuild so SQLite (round-trip test)
    # stays compatible.
    with op.batch_alter_table("journalentry") as batch_op:
        batch_op.create_check_constraint(_PRIMARY_RANGE_CHECK, _PRIMARY_RANGE_CONDITION)
        batch_op.create_check_constraint(_SECONDARY_RANGE_CHECK, _SECONDARY_RANGE_CONDITION)
        batch_op.create_check_constraint(_CHORD_SHAPE_CHECK, _CHORD_SHAPE_CONDITION)


def downgrade() -> None:
    """Drop the chord CHECKs and the two columns."""
    # Batch mode keeps the downgrade SQLite-compatible (no ALTER/DROP CHECK there).
    with op.batch_alter_table("journalentry") as batch_op:
        batch_op.drop_constraint(_CHORD_SHAPE_CHECK, type_="check")
        batch_op.drop_constraint(_SECONDARY_RANGE_CHECK, type_="check")
        batch_op.drop_constraint(_PRIMARY_RANGE_CHECK, type_="check")
        batch_op.drop_column("secondary_aspect")
        batch_op.drop_column("primary_aspect")
