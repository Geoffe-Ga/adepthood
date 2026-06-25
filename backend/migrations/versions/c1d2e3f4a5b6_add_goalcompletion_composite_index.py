"""add goalcompletion composite (goal_id, user_id, timestamp) index

Revision ID: c1d2e3f4a5b6
Revises: 18c9d0e1f2a3
Create Date: 2026-06-24 00:00:00.000000

Issue #466: ``goalcompletion`` is the app's highest-write table yet had no
index covering its hot read filters.  Every streak/stats query filters on
``goal_id`` / ``user_id`` and sorts by ``timestamp``, so each one
full-scanned and sorted the table (audit §5.3 missing index).  This adds a
single composite b-tree index over ``(goal_id, user_id, timestamp)`` so the
planner can satisfy those reads from the index.  Non-destructive and fully
reversible: ``upgrade`` creates the index, ``downgrade`` drops it.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c1d2e3f4a5b6"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "18c9d0e1f2a3"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_INDEX_NAME = "ix_goalcompletion_goal_user_ts"
_TABLE_NAME = "goalcompletion"
_INDEX_COLUMNS = ["goal_id", "user_id", "timestamp"]


def upgrade() -> None:
    """Create the composite read index covering streak/stats queries."""
    op.create_index(_INDEX_NAME, _TABLE_NAME, _INDEX_COLUMNS, unique=False)


def downgrade() -> None:
    """Drop the composite read index (reverts to full-scan reads)."""
    op.drop_index(_INDEX_NAME, table_name=_TABLE_NAME)
