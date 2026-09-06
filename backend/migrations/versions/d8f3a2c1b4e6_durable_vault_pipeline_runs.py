"""Persist durable Creek jobs and retry state for the vault pipeline.

Revision ID: d8f3a2c1b4e6
Revises: c7e4b91a2d38
Create Date: 2026-09-05 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "d8f3a2c1b4e6"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "c7e4b91a2d38"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "vaultpipelinerun"
_ACTIVE_INDEX = "ix_vaultpipelinerun_active_user_stage_unique"
_OUTCOME_INDEX = "ix_vaultpipelinerun_outcome_id"
_OLD_STAGE_CHECK = "stage IN ('classify', 'temporal', 'eddies', 'threads')"
_NEW_STAGE_CHECK = "stage IN ('classify', 'temporal', 'embeddings', 'eddies', 'threads')"
_OLD_OUTCOME_CHECK = "outcome IN ('attempted', 'completed', 'incomplete', 'failed')"
_NEW_OUTCOME_CHECK = "outcome IN ('attempted', 'completed', 'incomplete', 'failed', 'ambiguous')"


def upgrade() -> None:
    """Add durable job correlation, bounded retry state, and active-run exclusion."""
    op.add_column(
        _TABLE,
        sa.Column("trigger", sqlmodel.sql.sqltypes.AutoString(length=20), nullable=True),
    )
    op.add_column(
        _TABLE,
        sa.Column("job_id", sqlmodel.sql.sqltypes.AutoString(length=36), nullable=True),
    )
    op.add_column(
        _TABLE,
        sa.Column("attempt_count", sa.Integer(), server_default="1", nullable=False),
    )
    op.drop_constraint("ck_vaultpipelinerun_stage_valid", _TABLE, type_="check")
    op.drop_constraint("ck_vaultpipelinerun_outcome_valid", _TABLE, type_="check")
    op.create_check_constraint("ck_vaultpipelinerun_stage_valid", _TABLE, _NEW_STAGE_CHECK)
    op.create_check_constraint("ck_vaultpipelinerun_outcome_valid", _TABLE, _NEW_OUTCOME_CHECK)
    op.create_check_constraint(
        "ck_vaultpipelinerun_trigger_valid",
        _TABLE,
        "trigger IS NULL OR trigger IN ('journal_write', 'document_import')",
    )
    op.create_check_constraint(
        "ck_vaultpipelinerun_attempt_count_range", _TABLE, "attempt_count >= 1"
    )
    op.alter_column(_TABLE, "attempt_count", server_default=None)
    # Pre-0.14 attempted rows have no durable handle and cannot be reconciled.
    # Preserve that uncertainty explicitly instead of rewriting it as failure.
    op.execute(
        sa.text("UPDATE vaultpipelinerun SET outcome = 'ambiguous' WHERE outcome = 'attempted'")
    )
    op.create_index(_OUTCOME_INDEX, _TABLE, ["outcome", "id"])
    op.create_index(
        _ACTIVE_INDEX,
        _TABLE,
        ["user_id", "stage"],
        unique=True,
        postgresql_where=sa.text("outcome = 'attempted'"),
        sqlite_where=sa.text("outcome = 'attempted'"),
    )


def downgrade() -> None:
    """Return to the pre-job attempt log, discarding only embedding-job stamps."""
    op.drop_index(_ACTIVE_INDEX, table_name=_TABLE)
    op.drop_index(_OUTCOME_INDEX, table_name=_TABLE)
    op.execute(sa.text("DELETE FROM vaultpipelinerun WHERE stage = 'embeddings'"))
    op.execute(
        sa.text("UPDATE vaultpipelinerun SET outcome = 'failed' WHERE outcome = 'ambiguous'")
    )
    op.drop_constraint("ck_vaultpipelinerun_attempt_count_range", _TABLE, type_="check")
    op.drop_constraint("ck_vaultpipelinerun_trigger_valid", _TABLE, type_="check")
    op.drop_constraint("ck_vaultpipelinerun_outcome_valid", _TABLE, type_="check")
    op.drop_constraint("ck_vaultpipelinerun_stage_valid", _TABLE, type_="check")
    op.create_check_constraint("ck_vaultpipelinerun_stage_valid", _TABLE, _OLD_STAGE_CHECK)
    op.create_check_constraint("ck_vaultpipelinerun_outcome_valid", _TABLE, _OLD_OUTCOME_CHECK)
    op.drop_column(_TABLE, "attempt_count")
    op.drop_column(_TABLE, "job_id")
    op.drop_column(_TABLE, "trigger")
