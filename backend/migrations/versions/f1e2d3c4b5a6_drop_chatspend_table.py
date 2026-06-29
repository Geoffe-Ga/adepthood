"""drop the retired chatspend table

Revision ID: f1e2d3c4b5a6
Revises: d4c3b2a1f6e5
Create Date: 2026-06-28 00:00:00.000000

The chat endpoints were retired in favour of journal resonance (the chat UI +
client were removed earlier); the ChatSpend idempotency model that backed
``/journal/chat`` and ``/journal/chat/stream`` is now dead code. Drop its table.
``downgrade`` recreates the table to match the removed model so the migration is
reversible.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f1e2d3c4b5a6"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "d4c3b2a1f6e5"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Drop the retired chatspend table and its indexes."""
    op.drop_table("chatspend")


def downgrade() -> None:
    """Recreate the chatspend table matching the removed ChatSpend model."""
    op.create_table(
        "chatspend",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("idem_key", sa.String(length=128), nullable=False),
        sa.Column("result_json", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "idem_key", name="uq_chatspend_user_idem_key"),
    )
    op.create_index("ix_chatspend_user_id", "chatspend", ["user_id"])
    op.create_index("ix_chatspend_idem_key", "chatspend", ["idem_key"])
