"""add journalentry composite (user_id, timestamp, id) ordering index

Revision ID: f8a9b0c1d2e3
Revises: e8f9a0b1c2d3
Create Date: 2026-07-10 00:00:00.000000

Issue #1788: backdated journal entries carry a ``timestamp`` earlier than their
insertion id, so the list endpoint now orders by ``(timestamp DESC, id DESC)``
(id breaks ties for entries sharing a noon-UTC timestamp) instead of ``id DESC``.
The prior indexes did not cover that ordering, so a paged list scanned + sorted
the user's full journal history.  This adds a composite b-tree index over
``(user_id, timestamp, id)`` covering the new ``(timestamp DESC, id DESC)`` list
read.  Non-destructive and fully reversible.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f8a9b0c1d2e3"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "e8f9a0b1c2d3"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_INDEX_NAME = "ix_journalentry_user_timestamp_id"
_TABLE_NAME = "journalentry"
_INDEX_COLUMNS = ["user_id", "timestamp", "id"]


def upgrade() -> None:
    """Create the composite index covering the timestamp-ordered list read."""
    op.create_index(_INDEX_NAME, _TABLE_NAME, _INDEX_COLUMNS, unique=False)


def downgrade() -> None:
    """Drop the composite index (reverts to scanning + sorting the list read)."""
    op.drop_index(_INDEX_NAME, table_name=_TABLE_NAME)
