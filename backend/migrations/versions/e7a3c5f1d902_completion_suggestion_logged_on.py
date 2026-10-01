"""add completionsuggestion.logged_on (the day a habit accept logged)

Revision ID: e7a3c5f1d902
Revises: 6e6fe6af2c30
Create Date: 2026-10-01 00:00:00.000000

Issue #2905. ``completed_on`` is the day detection read in the span; the
accept logs that day only while it is still inside the backfill window, and
the user's today otherwise. Nothing recorded which, so the settled card
re-derived the day from ``completed_on`` and the live clock and could name a
day the completion was never on. ``logged_on`` records the day the accept
resolved -- the same value written to ``goalcompletion.local_day``.

Nullable, with no backfill: a habit row accepted before this revision kept no
record of the day it logged, and re-deriving one is exactly the guess this
column exists to stop. The settled card omits the day for those rows.

The facts-habit-only CHECK (``d4e7c9a1b830``) is widened to cover the new
column: a practice accept logs no day, so a value there could only be a
journal-derived date captured and ignored. The downgrade restores the
previous expression exactly before dropping the column.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e7a3c5f1d902"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "6e6fe6af2c30"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "completionsuggestion"
_COLUMN = "logged_on"
_FACTS_HABIT_ONLY = "ck_completion_suggestion_facts_habit_only"
# Both expressions are spelled out rather than imported from the model: a
# migration is a frozen record of the DDL it ran.
_CHECK_BEFORE = "target_type = 'habit' OR (completed_units IS NULL AND completed_on IS NULL)"
_CHECK_AFTER = (
    "target_type = 'habit'"
    " OR (completed_units IS NULL AND completed_on IS NULL AND logged_on IS NULL)"
)


def upgrade() -> None:
    """Add the nullable column, then widen the habit-only CHECK to cover it."""
    # SQLite supports plain ADD COLUMN; only the CHECK needs the table rebuild.
    op.add_column(_TABLE, sa.Column(_COLUMN, sa.Date(), nullable=True))
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_constraint(_FACTS_HABIT_ONLY, type_="check")
        batch_op.create_check_constraint(_FACTS_HABIT_ONLY, _CHECK_AFTER)


def downgrade() -> None:
    """Restore the previous habit-only CHECK, then drop the column."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_constraint(_FACTS_HABIT_ONLY, type_="check")
        batch_op.create_check_constraint(_FACTS_HABIT_ONLY, _CHECK_BEFORE)
        batch_op.drop_column(_COLUMN)
