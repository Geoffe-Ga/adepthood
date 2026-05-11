"""add chatspend table for chat idempotency (BUG-BM-012)

Revision ID: b1c2d3e4f5a6
Revises: a0b1c2d3e4f5
Create Date: 2026-05-11 13:00:00.000000

BUG-BM-012: creates the ``chatspend`` table with a unique ``(user_id,
idem_key)`` constraint so duplicate ``/journal/chat`` or
``/journal/chat/stream`` requests with the same ``Idempotency-Key`` header
return the cached result without re-debiting the wallet.

The ``idem_key`` column stores a SHA-256 digest of the raw header value;
``result_json`` stores the serialised response so replays can return the
same body.  ``result_json`` is NULL during in-flight so a crash between
deduction and LLM completion leaves a detectable "pending" tombstone.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b1c2d3e4f5a6"  # pragma: allowlist secret
down_revision: Union[str, None] = "a0b1c2d3e4f5"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create the ``chatspend`` table."""
    op.create_table(
        "chatspend",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("idem_key", sa.String(128), nullable=False),
        sa.Column("result_json", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "idem_key", name="uq_chatspend_user_idem_key"),
    )
    op.create_index("ix_chatspend_user_id", "chatspend", ["user_id"], unique=False)
    op.create_index("ix_chatspend_idem_key", "chatspend", ["idem_key"], unique=False)


def downgrade() -> None:
    """Drop the ``chatspend`` table."""
    op.drop_index("ix_chatspend_idem_key", table_name="chatspend")
    op.drop_index("ix_chatspend_user_id", table_name="chatspend")
    op.drop_table("chatspend")
