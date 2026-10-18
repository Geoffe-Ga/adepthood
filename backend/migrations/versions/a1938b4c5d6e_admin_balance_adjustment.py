"""Add durable admin wallet adjustment audit and idempotency.

Revision ID: a1938b4c5d6e
Revises: 15c817227402
Create Date: 2026-10-18 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a1938b4c5d6e"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "15c817227402"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "adminbalanceadjustment"
_IDEMPOTENCY_INDEX = "ix_adminbalanceadjustment_actor_idem_key"


def upgrade() -> None:
    """Create the adjustment paper trail and its keyed-replay guard."""
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "target_user_id",
            sa.Integer(),
            sa.ForeignKey("user.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "actor_admin_id",
            sa.Integer(),
            sa.ForeignKey("user.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("delta", sa.Integer(), nullable=False),
        sa.Column("balance_after", sa.Integer(), nullable=False),
        sa.Column("reason", sa.String(length=500), nullable=False),
        sa.Column("source_ip", sa.String(length=45), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=True),
        sa.Column("request_fingerprint", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_adminbalanceadjustment_target_user_id",
        _TABLE,
        ["target_user_id"],
    )
    op.create_index(
        "ix_adminbalanceadjustment_actor_admin_id",
        _TABLE,
        ["actor_admin_id"],
    )
    op.create_index("ix_adminbalanceadjustment_created_at", _TABLE, ["created_at"])
    op.create_index(
        _IDEMPOTENCY_INDEX,
        _TABLE,
        ["actor_admin_id", "idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
        sqlite_where=sa.text("idempotency_key IS NOT NULL"),
    )


def downgrade() -> None:
    """Drop the admin wallet adjustment paper trail."""
    op.drop_index(_IDEMPOTENCY_INDEX, table_name=_TABLE)
    op.drop_index("ix_adminbalanceadjustment_created_at", table_name=_TABLE)
    op.drop_index("ix_adminbalanceadjustment_actor_admin_id", table_name=_TABLE)
    op.drop_index("ix_adminbalanceadjustment_target_user_id", table_name=_TABLE)
    op.drop_table(_TABLE)
