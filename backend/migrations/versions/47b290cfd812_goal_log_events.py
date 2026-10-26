"""Keep each goal check-in's signed units and original logging time.

Revision ID: 47b290cfd812
Revises: 06ce4a324061
Create Date: 2026-10-25

No backfill: daily aggregate timestamps cannot recover individual log times.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "47b290cfd812"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "06ce4a324061"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the event ledger without inventing historical events."""
    op.create_table(
        "goallogevent",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("goal_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("local_day", sa.Date(), nullable=False),
        sa.Column("delta_units", sa.Float(), nullable=False),
        sa.Column("via_timer", sa.Boolean(), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.CheckConstraint(
            "source IN ('manual', 'timer', 'journal', 'practice_link', 'backfill')",
            name="ck_goallogevent_source_valid",
        ),
        sa.CheckConstraint("delta_units != 0", name="ck_goallogevent_delta_nonzero"),
        sa.ForeignKeyConstraint(["goal_id"], ["goal.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_goallogevent_goal_user_ts", "goallogevent", ["goal_id", "user_id", "timestamp"]
    )


def downgrade() -> None:
    """Drop per-log provenance, retaining the existing daily aggregates."""
    op.drop_index("ix_goallogevent_goal_user_ts", table_name="goallogevent")
    op.drop_table("goallogevent")
