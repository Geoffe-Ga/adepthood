"""add energyplan table for durable energy-plan persistence

Revision ID: c8d9e0f1a2b3
Revises: e3f4a5b6c7d8
Create Date: 2026-06-25 00:00:00.000000

Generated energy plans used to live only in a per-process ``TTLCache``: lost on
restart and divergent across workers for the same ``idempotency_key``. This
table makes a plan a durable, cross-worker record so a keyed retry replays the
stored plan verbatim.

Purely additive: ``upgrade`` creates the table and its two indexes; ``downgrade``
drops them. No ``ALTER`` / ``DROP`` against existing tables. The partial UNIQUE
index on ``(user_id, idempotency_key)`` only constrains non-NULL keys, so
unkeyed requests each get their own row.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c8d9e0f1a2b3"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "e3f4a5b6c7d8"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create the ``energyplan`` table and its indexes."""
    op.create_table(
        "energyplan",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("idempotency_key", sa.String(length=255), nullable=True),
        sa.Column("plan_json", sa.Text(), nullable=False),
        sa.Column("reason_code", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_energyplan_user_id", "energyplan", ["user_id"])
    # Deduplicate keyed requests per (user, key); NULL keys are unconstrained
    # so unkeyed plans each get their own row.
    op.create_index(
        "ix_energyplan_user_idem_key",
        "energyplan",
        ["user_id", "idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
        sqlite_where=sa.text("idempotency_key IS NOT NULL"),
    )


def downgrade() -> None:
    """Drop the ``energyplan`` table and its indexes."""
    op.drop_index("ix_energyplan_user_idem_key", table_name="energyplan")
    op.drop_index("ix_energyplan_user_id", table_name="energyplan")
    op.drop_table("energyplan")
