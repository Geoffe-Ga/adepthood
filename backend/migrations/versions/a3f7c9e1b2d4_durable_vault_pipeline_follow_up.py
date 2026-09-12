"""Queue one durable classification after a write joins an active snapshot.

Revision ID: a3f7c9e1b2d4
Revises: f2a3b4c5d6e7
Create Date: 2026-09-12 00:00:00.000000

The existing active-row exclusion prevents concurrent classification, but its
old trigger promotion also made a late write look covered by a snapshot that
had already been taken.  ``follow_up_trigger`` records only the stronger scope
of those joined writes.  Terminalizing the active row can then enqueue exactly
one successor in the same transaction.  ``queued`` distinguishes that durable
promise from an admission whose HTTP outcome is already uncertain.

Both fields are content-free closed vocabulary.  No fragment identifier,
filename, excerpt, path, or body crosses into scheduling metadata.
"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "a3f7c9e1b2d4"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "f2a3b4c5d6e7"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "vaultpipelinerun"
_ACTIVE_INDEX = "ix_vaultpipelinerun_active_user_stage_unique"
_OLD_OUTCOMES = "outcome IN ('attempted', 'completed', 'incomplete', 'failed', 'ambiguous')"
_NEW_OUTCOMES = (
    "outcome IN ('queued', 'attempted', 'completed', 'incomplete', 'failed', 'ambiguous')"
)
_OLD_ATTEMPTS = "attempt_count >= 1"
_NEW_ATTEMPTS = (
    "(outcome = 'queued' AND attempt_count = 0) OR (outcome != 'queued' AND attempt_count >= 1)"
)
_TRIGGERS = "follow_up_trigger IN ('journal_write', 'document_import')"


def upgrade() -> None:
    """Add the joined-write marker and make queued work uniquely recoverable."""
    op.add_column(
        _TABLE,
        sa.Column(
            "follow_up_trigger",
            sqlmodel.sql.sqltypes.AutoString(length=20),
            nullable=True,
        ),
    )
    op.drop_index(_ACTIVE_INDEX, table_name=_TABLE)
    op.drop_constraint("ck_vaultpipelinerun_outcome_valid", _TABLE, type_="check")
    op.drop_constraint("ck_vaultpipelinerun_attempt_count_range", _TABLE, type_="check")
    op.create_check_constraint("ck_vaultpipelinerun_outcome_valid", _TABLE, _NEW_OUTCOMES)
    op.create_check_constraint("ck_vaultpipelinerun_attempt_count_range", _TABLE, _NEW_ATTEMPTS)
    op.create_check_constraint(
        "ck_vaultpipelinerun_follow_up_trigger_valid",
        _TABLE,
        f"follow_up_trigger IS NULL OR {_TRIGGERS}",
    )
    op.create_index(
        _ACTIVE_INDEX,
        _TABLE,
        ["user_id", "stage"],
        unique=True,
        postgresql_where=sa.text("outcome IN ('queued', 'attempted')"),
        sqlite_where=sa.text("outcome IN ('queued', 'attempted')"),
    )


def downgrade() -> None:
    """Retire queued work as ambiguous before restoring the old vocabulary."""
    op.drop_index(_ACTIVE_INDEX, table_name=_TABLE)
    op.execute(
        sa.text(
            "UPDATE vaultpipelinerun SET outcome = 'ambiguous', attempt_count = 1 "
            "WHERE outcome = 'queued'"
        )
    )
    op.drop_constraint("ck_vaultpipelinerun_follow_up_trigger_valid", _TABLE, type_="check")
    op.drop_constraint("ck_vaultpipelinerun_attempt_count_range", _TABLE, type_="check")
    op.drop_constraint("ck_vaultpipelinerun_outcome_valid", _TABLE, type_="check")
    op.create_check_constraint("ck_vaultpipelinerun_outcome_valid", _TABLE, _OLD_OUTCOMES)
    op.create_check_constraint("ck_vaultpipelinerun_attempt_count_range", _TABLE, _OLD_ATTEMPTS)
    op.create_index(
        _ACTIVE_INDEX,
        _TABLE,
        ["user_id", "stage"],
        unique=True,
        postgresql_where=sa.text("outcome = 'attempted'"),
        sqlite_where=sa.text("outcome = 'attempted'"),
    )
    op.drop_column(_TABLE, "follow_up_trigger")
