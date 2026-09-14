"""Record explicit managed-vault custody and retire the ceremony lifecycle.

Revision ID: c5d9e1f3a7b2
Revises: b4c8d2e6f0a1
Create Date: 2026-09-14 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c5d9e1f3a7b2"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "b4c8d2e6f0a1"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "vaultactivation"
_STATE_CONSTRAINT = "ck_vaultactivation_state_valid"
_CUSTODY_CONSTRAINT = "ck_vaultactivation_custody_mode_valid"
_CURRENT_STATES = (
    "'submitting', 'pending', 'provisioning', 'awaiting_handoff', 'ready', "
    "'failed', 'deleting', 'deleted'"
)
_LEGACY_STATES = (
    "'submitting', 'pending', 'provisioning', 'awaiting_key_ceremony', "
    "'awaiting_handoff', 'ready', 'failed', 'deleting', 'deleted'"
)


def upgrade() -> None:
    """Add custody truth and make every retired ceremony row terminal."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.add_column(sa.Column("custody_mode", sa.String(length=32), nullable=True))

    # Adepthood did not persist Creek's ceremony receipt, so state and the old
    # attestation boolean cannot prove custody for a terminal or in-flight row.
    # Leave those modes unknown and clear the now-retired confidentiality claim.
    # Only an explicit ceremony state proves wrapped-artifact provenance. Such a
    # job can no longer progress because v2 exposes no ceremony endpoint, so
    # settle it as a visible, non-retryable failure instead of stranding it.
    op.execute(
        sa.text(
            "UPDATE vaultactivation SET attested_confidential = false, "
            "custody_mode = CASE WHEN state = 'awaiting_key_ceremony' "
            "THEN 'wrapped_artifact_only' ELSE NULL END"
        )
    )
    op.execute(
        sa.text(
            "UPDATE vaultactivation "
            "SET state = 'failed', retryable = false, failure_reason = 'provider_rejected' "
            "WHERE state = 'awaiting_key_ceremony'"
        )
    )

    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_constraint(_STATE_CONSTRAINT, type_="check")
        batch_op.create_check_constraint(
            _STATE_CONSTRAINT,
            f"state IN ({_CURRENT_STATES})",
        )
        batch_op.create_check_constraint(
            _CUSTODY_CONSTRAINT,
            "custody_mode IS NULL OR custody_mode IN ('provider_managed', 'wrapped_artifact_only')",
        )


def downgrade() -> None:
    """Drop custody truth while restoring the historical state vocabulary."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_constraint(_CUSTODY_CONSTRAINT, type_="check")
        batch_op.drop_constraint(_STATE_CONSTRAINT, type_="check")
        batch_op.create_check_constraint(
            _STATE_CONSTRAINT,
            f"state IN ({_LEGACY_STATES})",
        )
        batch_op.drop_column("custody_mode")
