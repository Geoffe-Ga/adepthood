"""add completionsuggestion.completed_units + completionsuggestion.completed_on

Revision ID: d4e7c9a1b830
Revises: c5d9e1f3a7b2
Create Date: 2026-09-16 00:00:00.000000

Detection now extracts how much the writer says they did and on which
user-local day, so the accept path can log *that* amount on *that* day
instead of the goal's target on today (#2842).

Both columns are nullable: a suggestion whose span states neither carries
NULL in both and behaves exactly as it did before this revision.

Two CHECKs travel with them. ``completed_units`` is detection output, so
a zero or negative would flow into the check-in service's explicit-delta
path and silently shrink a day the writer meant to add to; it must be
NULL or strictly positive. And the facts are habit-only: a practice
suggestion backdates nothing and reads neither column, so a fact there
would be captured and then ignored. Relaxing the second CHECK is the
single-migration reversal path when practice sessions become backdatable.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d4e7c9a1b830"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "c5d9e1f3a7b2"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "completionsuggestion"
_UNITS_POSITIVE = "ck_completion_suggestion_completed_units_positive"
_FACTS_HABIT_ONLY = "ck_completion_suggestion_facts_habit_only"


def upgrade() -> None:
    """Add both nullable fact columns, then their two CHECKs."""
    # SQLite supports plain ADD COLUMN; only the CHECKs need the table rebuild.
    op.add_column(_TABLE, sa.Column("completed_units", sa.Float(), nullable=True))
    op.add_column(_TABLE, sa.Column("completed_on", sa.Date(), nullable=True))
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.create_check_constraint(
            _UNITS_POSITIVE,
            "completed_units IS NULL OR completed_units > 0",
        )
        batch_op.create_check_constraint(
            _FACTS_HABIT_ONLY,
            "target_type = 'habit' OR (completed_units IS NULL AND completed_on IS NULL)",
        )


def downgrade() -> None:
    """Drop both CHECKs and both columns."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_constraint(_FACTS_HABIT_ONLY, type_="check")
        batch_op.drop_constraint(_UNITS_POSITIVE, type_="check")
        batch_op.drop_column("completed_on")
        batch_op.drop_column("completed_units")
