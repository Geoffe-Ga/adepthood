"""goal_completion unique per day and compound index

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-04-16 00:03:00.000000

BUG-HABITS-015 / BUG-GOAL-005: Adds a unique index on (goal_id, user_id, date)
to prevent duplicate completions for the same goal on the same day.

BUG-HABITS-002: Adds a compound index on (goal_id, user_id, timestamp) to
speed up streak computation queries.

The unique-per-day expression uses ``(timestamp AT TIME ZONE 'UTC')::date``
because ``timestamp::date`` on a ``TIMESTAMP WITH TIME ZONE`` column is
STABLE (depends on session timezone) and Postgres refuses to index it.
Forcing UTC makes the expression IMMUTABLE and matches the application's
"all timestamps are stored in UTC" invariant established by
``78b1620cafde_convert_datetime_columns_to_timestamptz``.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d4e5f6a7b8c9"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "c3d4e5f6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_UNIQUE_PER_DAY_INDEX = "ix_goal_completion_unique_per_day"
_COMPOUND_INDEX = "ix_goal_completion_goal_user_timestamp"


def upgrade() -> None:
    """Add unique-per-day constraint and compound performance index."""
    op.execute(
        f'CREATE UNIQUE INDEX "{_UNIQUE_PER_DAY_INDEX}" '
        "ON goalcompletion (goal_id, user_id, ((timestamp AT TIME ZONE 'UTC')::date))"
    )
    op.execute(
        f'CREATE INDEX "{_COMPOUND_INDEX}" '
        "ON goalcompletion (goal_id, user_id, timestamp)"
    )


def downgrade() -> None:
    """Drop both indexes."""
    op.execute(f'DROP INDEX IF EXISTS "{_COMPOUND_INDEX}"')
    op.execute(f'DROP INDEX IF EXISTS "{_UNIQUE_PER_DAY_INDEX}"')
