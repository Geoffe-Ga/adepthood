"""Add durable Creek activation and post-account teardown receipts.

Revision ID: e9a4c6d8f0b2
Revises: d8f3a2c1b4e6
Create Date: 2026-09-07 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "e9a4c6d8f0b2"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "d8f3a2c1b4e6"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ACTIVATION = "vaultactivation"
_TEARDOWN = "vaultteardownreceipt"
_IDENTITY = sqlmodel.sql.sqltypes.AutoString(length=200)
_STATE = sqlmodel.sql.sqltypes.AutoString(length=32)
_REASON = sqlmodel.sql.sqltypes.AutoString(length=64)


def upgrade() -> None:
    """Create the user-owned activation and detached cleanup ledger."""
    op.add_column(
        "uservaultconfig",
        sa.Column("provisioned", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.alter_column("uservaultconfig", "provisioned", server_default=None)
    op.create_table(
        _ACTIVATION,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("activation_id", _IDENTITY, nullable=False),
        sa.Column("consumer_identity", _IDENTITY, nullable=False),
        sa.Column("creek_job_id", _IDENTITY, nullable=True),
        sa.Column("state", _STATE, nullable=False),
        sa.Column("retryable", sa.Boolean(), nullable=False),
        sa.Column("failure_reason", _REASON, nullable=True),
        sa.Column("credential_received_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attested_confidential", sa.Boolean(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "state IN ('submitting', 'pending', 'provisioning', "
            "'awaiting_key_ceremony', 'awaiting_handoff', 'ready', 'failed', "
            "'deleting', 'deleted')",
            name="ck_vaultactivation_state_valid",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("activation_id"),
        sa.UniqueConstraint("consumer_identity"),
        sa.UniqueConstraint("creek_job_id"),
        sa.UniqueConstraint("user_id"),
    )
    op.create_index("ix_vaultactivation_state_id", _ACTIVATION, ["state", "id"])
    op.create_table(
        _TEARDOWN,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("creek_job_id", _IDENTITY, nullable=False),
        sa.Column("state", _STATE, nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("retryable", sa.Boolean(), nullable=False),
        sa.Column("failure_reason", _REASON, nullable=True),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "state IN ('deleting', 'deleted', 'failed')",
            name="ck_vaultteardownreceipt_state_valid",
        ),
        sa.CheckConstraint("attempts >= 0", name="ck_vaultteardownreceipt_attempts_range"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("creek_job_id"),
    )
    op.create_index(
        "ix_vaultteardownreceipt_state_updated",
        _TEARDOWN,
        ["state", "updated_at"],
    )


def downgrade() -> None:
    """Remove activation state after dropping its lookup indexes."""
    op.drop_index("ix_vaultteardownreceipt_state_updated", table_name=_TEARDOWN)
    op.drop_table(_TEARDOWN)
    op.drop_index("ix_vaultactivation_state_id", table_name=_ACTIVATION)
    op.drop_table(_ACTIVATION)
    op.drop_column("uservaultconfig", "provisioned")
