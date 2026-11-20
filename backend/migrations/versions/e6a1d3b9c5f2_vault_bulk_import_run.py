"""One vault pass per drained bulk upload: ``vaultbulkimportrun`` and ``bulk_import`` (#3773).

Revision ID: e6a1d3b9c5f2
Revises: 3f7a9c2e5b18
Create Date: 2026-11-20 00:00:00.000000

Two changes, one feature.

**``vaultbulkimportrun``.** One row per press of ``POST /corpus/import/complete``
(see ``models.vault_bulk_import_run``): the client's random batch id, its landed
count, a closed state and stop-reason vocabulary, an opaque lease (owner token
and heartbeat), the instant the pass was handed to the durable pipeline, and
two more instants. Content-free. ``uq_vaultbulkimportrun_user_batch`` makes a
press idempotent per batch; the partial unique index
``ix_vaultbulkimportrun_running_user_unique`` keeps at most one ``running``
row per account, across workers.

**``bulk_import`` as a pipeline trigger.** ``vaultpipelinerun.trigger``,
``vaultpipelinerun.follow_up_trigger`` and ``vaultpipelinefollowup.trigger``
are ``VARCHAR(20)`` columns guarded by CHECKs written as literals by
``d8f3a2c1b4e6`` and ``a3f7c9e1b2d4``. Each is dropped and recreated with
``bulk_import`` added, inside ``batch_alter_table`` so SQLite rebuilds each
table once.

The CHECK SQL is frozen here rather than imported from ``src``, so this revision
means the same thing forever; it matches the models' derived CHECKs.
``downgrade`` re-scopes every ``bulk_import`` stamp to ``document_import`` --
the same whole ladder, under the windows an older build understands -- before
narrowing the CHECKs, and drops the run table, which holds scheduling state only.
"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e6a1d3b9c5f2"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "3f7a9c2e5b18"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "vaultbulkimportrun"
_USER_INDEX = "ix_vaultbulkimportrun_user_id_id"
_RUNNING_INDEX = "ix_vaultbulkimportrun_running_user_unique"
_BATCH_UNIQUE = "uq_vaultbulkimportrun_user_batch"

_RUN_TABLE = "vaultpipelinerun"
_FOLLOW_UP_TABLE = "vaultpipelinefollowup"
_RUN_TRIGGER_CHECK = "ck_vaultpipelinerun_trigger_valid"
_RUN_FOLLOW_UP_CHECK = "ck_vaultpipelinerun_follow_up_trigger_valid"
_FOLLOW_UP_CHECK = "ck_vaultpipelinefollowup_trigger_valid"

# Widths, frozen at this revision (mirrored by models.vault_bulk_import_run).
_BATCH_ID_WIDTH = 64
_STATE_WIDTH = 16
_STOP_REASON_WIDTH = 32
_OWNER_WIDTH = 32

STATE_CONDITION = "state IN ('queued', 'running', 'completed', 'stopped', 'failed')"
STOP_REASON_CONDITION = (
    "(state = 'stopped' AND stop_reason IS NOT NULL AND stop_reason IN "
    "('vault_unavailable', 'pipeline_unsupported')) "
    "OR (state <> 'stopped' AND stop_reason IS NULL)"
)
FINISHED_CONDITION = (
    "(state IN ('queued', 'running') AND finished_at IS NULL) "
    "OR (state NOT IN ('queued', 'running') AND finished_at IS NOT NULL)"
)
LEASE_CONDITION = (
    "(state = 'running' AND owner_id IS NOT NULL AND heartbeat_at IS NOT NULL) "
    "OR (state <> 'running' AND owner_id IS NULL AND heartbeat_at IS NULL)"
)
LANDED_CONDITION = "landed >= 0"
RUNNING_CONDITION = "state = 'running'"

_BULK = "bulk_import"
_DOCUMENT = "document_import"
_PREVIOUS_TRIGGERS = "'journal_write', 'document_import'"
_WIDENED_TRIGGERS = "'journal_write', 'document_import', 'bulk_import'"


def _replace_trigger_checks(triggers: str) -> None:
    """Drop and recreate the three trigger CHECKs over ``triggers``."""
    with op.batch_alter_table(_RUN_TABLE) as batch_op:
        batch_op.drop_constraint(_RUN_TRIGGER_CHECK, type_="check")
        batch_op.drop_constraint(_RUN_FOLLOW_UP_CHECK, type_="check")
        batch_op.create_check_constraint(
            _RUN_TRIGGER_CHECK, f"trigger IS NULL OR trigger IN ({triggers})"
        )
        batch_op.create_check_constraint(
            _RUN_FOLLOW_UP_CHECK,
            f"follow_up_trigger IS NULL OR follow_up_trigger IN ({triggers})",
        )
    with op.batch_alter_table(_FOLLOW_UP_TABLE) as batch_op:
        batch_op.drop_constraint(_FOLLOW_UP_CHECK, type_="check")
        batch_op.create_check_constraint(_FOLLOW_UP_CHECK, f"trigger IN ({triggers})")


def upgrade() -> None:
    """Admit ``bulk_import`` as a trigger, and create the bulk run table."""
    _replace_trigger_checks(_WIDENED_TRIGGERS)
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column(
            "batch_id", sqlmodel.sql.sqltypes.AutoString(length=_BATCH_ID_WIDTH), nullable=False
        ),
        sa.Column("landed", sa.Integer(), nullable=False),
        sa.Column("state", sqlmodel.sql.sqltypes.AutoString(length=_STATE_WIDTH), nullable=False),
        sa.Column(
            "stop_reason",
            sqlmodel.sql.sqltypes.AutoString(length=_STOP_REASON_WIDTH),
            nullable=True,
        ),
        sa.Column("owner_id", sqlmodel.sql.sqltypes.AutoString(length=_OWNER_WIDTH), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dispatched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(STATE_CONDITION, name="ck_vaultbulkimportrun_state_valid"),
        sa.CheckConstraint(STOP_REASON_CONDITION, name="ck_vaultbulkimportrun_stop_reason_valid"),
        sa.CheckConstraint(FINISHED_CONDITION, name="ck_vaultbulkimportrun_finished_at_valid"),
        sa.CheckConstraint(LEASE_CONDITION, name="ck_vaultbulkimportrun_lease_valid"),
        sa.CheckConstraint(LANDED_CONDITION, name="ck_vaultbulkimportrun_landed_valid"),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "batch_id", name=_BATCH_UNIQUE),
    )
    op.create_index(_USER_INDEX, _TABLE, ["user_id", "id"], unique=False)
    op.create_index(
        _RUNNING_INDEX,
        _TABLE,
        ["user_id"],
        unique=True,
        postgresql_where=sa.text(RUNNING_CONDITION),
        sqlite_where=sa.text(RUNNING_CONDITION),
    )


def downgrade() -> None:
    """Drop the run table, re-scope bulk stamps as document imports, narrow the CHECKs."""
    op.drop_index(_RUNNING_INDEX, table_name=_TABLE)
    op.drop_index(_USER_INDEX, table_name=_TABLE)
    op.drop_table(_TABLE)
    for statement in (
        "UPDATE vaultpipelinerun SET trigger = :document WHERE trigger = :bulk",
        "UPDATE vaultpipelinerun SET follow_up_trigger = :document WHERE follow_up_trigger = :bulk",
        "UPDATE vaultpipelinefollowup SET trigger = :document WHERE trigger = :bulk",
    ):
        op.execute(sa.text(statement).bindparams(document=_DOCUMENT, bulk=_BULK))
    _replace_trigger_checks(_PREVIOUS_TRIGGERS)
