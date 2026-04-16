"""goal_completion unique per day and compound index

Revision ID: a1b2c3d4e5f6
Revises: e8376b41c6a1
Create Date: 2026-04-16 00:00:00.000000

BUG-HABITS-015 / BUG-GOAL-005: Adds a unique index on (goal_id, user_id, date)
to prevent duplicate completions for the same goal on the same day.

BUG-HABITS-002: Adds a compound index on (goal_id, user_id, timestamp) to
speed up streak computation queries.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a1b2c3d4e5f6"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "e8376b41c6a1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_UNIQUE_PER_DAY_INDEX = "ix_goal_completion_unique_per_day"
_COMPOUND_INDEX = "ix_goal_completion_goal_user_timestamp"


def upgrade() -> None:
    """Add unique-per-day constraint and compound performance index."""
    op.execute(
        f'CREATE UNIQUE INDEX "{_UNIQUE_PER_DAY_INDEX}" '
        "ON goalcompletion (goal_id, user_id, (timestamp::date))"
    )
    op.execute(
        f'CREATE INDEX "{_COMPOUND_INDEX}" '
        "ON goalcompletion (goal_id, user_id, timestamp)"
    )


def downgrade() -> None:
    """Drop both indexes."""
    op.execute(f'DROP INDEX IF EXISTS "{_COMPOUND_INDEX}"')
    op.execute(f'DROP INDEX IF EXISTS "{_UNIQUE_PER_DAY_INDEX}"')
