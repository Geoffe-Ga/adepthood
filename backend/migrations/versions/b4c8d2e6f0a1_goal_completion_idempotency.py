"""add durable idempotency receipts for signed goal-completion deltas.

Revision ID: b4c8d2e6f0a1
Revises: a3f7c9e1b2d4
Create Date: 2026-09-13 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b4c8d2e6f0a1"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "a3f7c9e1b2d4"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the exactly-once receipt table for explicit check-in operations."""
    op.create_table(
        "goalcompletionspend",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("idem_key", sa.String(length=64), nullable=False),
        sa.Column("goal_id", sa.Integer(), nullable=False),
        sa.Column("local_day", sa.Date(), nullable=False),
        sa.Column("completed_units", sa.Float(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["goal_id"], ["goal.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "idem_key",
            name="uq_goalcompletionspend_user_idem_key",
        ),
    )


def downgrade() -> None:
    """Drop explicit-check-in idempotency receipts."""
    op.drop_table("goalcompletionspend")
