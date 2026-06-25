"""add journalentry composite (user_id, sender, deleted_at) index

Revision ID: e3f4a5b6c7d8
Revises: c1d2e3f4a5b6
Create Date: 2026-06-24 00:00:00.000000

Issue #469: ``load_recent_conversation`` filters ``journalentry`` on
``(user_id, sender, deleted_at)`` and orders by ``id DESC``, but the only
index was the single-column ``ix_journalentry_deleted_at``, so every chat
turn scanned the user's full journal history (audit §5.3 missing composite
index).  This adds a composite b-tree index over
``(user_id, sender, deleted_at)`` covering that read.  The original
``deleted_at`` index is left intact.  Non-destructive and fully reversible.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e3f4a5b6c7d8"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "c1d2e3f4a5b6"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_INDEX_NAME = "ix_journalentry_user_sender_deleted"
_TABLE_NAME = "journalentry"
_INDEX_COLUMNS = ["user_id", "sender", "deleted_at"]


def upgrade() -> None:
    """Create the composite index covering the chat read path."""
    op.create_index(_INDEX_NAME, _TABLE_NAME, _INDEX_COLUMNS, unique=False)


def downgrade() -> None:
    """Drop the composite index (reverts to scanning + the deleted_at index)."""
    op.drop_index(_INDEX_NAME, table_name=_TABLE_NAME)
