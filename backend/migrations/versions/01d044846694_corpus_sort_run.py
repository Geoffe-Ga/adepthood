"""One press of Sort, carried to the end in the background: ``corpussortrun``.

Revision ID: 01d044846694
Revises: e5c1a8f3b7d2
Create Date: 2026-11-03 00:00:00.000000

Creates ``corpussortrun``, one row per background sort of an account's backlog
(see ``models.corpus_sort_run`` for why a run is a row): a closed lane, state
and stop-reason vocabulary, three counts, an opaque lease (owner token and
heartbeat) and three instants. Content-free.

The partial unique index ``ix_corpussortrun_running_user_unique`` is the
single-flight guarantee -- at most one ``running`` row per account -- and is
why a second press joins the run already going, across workers.

The CHECK SQL and names are frozen literals here rather than imported from
``src``, so this revision means the same thing forever; they are identical to
the model's ``__table_args__`` (pinned by ``tests/test_corpus_sort_run_model.py``)
so ``alembic check`` sees no drift. ``downgrade`` drops the table: it holds
scheduling state only, and what each sort reached is kept in ``corpussweep``.
"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "01d044846694"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "e5c1a8f3b7d2"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "corpussortrun"
_USER_INDEX = "ix_corpussortrun_user_id_id"
_RUNNING_INDEX = "ix_corpussortrun_running_user_unique"

# Widths, frozen at this revision (mirrored by models.corpus_sort_run).
_LANE_WIDTH = 16
_STATE_WIDTH = 16
_STOP_REASON_WIDTH = 32
_OWNER_WIDTH = 32

LANE_CONDITION = "lane IN ('app_provider', 'vault_bound')"
STATE_CONDITION = "state IN ('running', 'completed', 'stopped', 'failed')"
STOP_REASON_CONDITION = (
    "(state = 'stopped' AND stop_reason IS NOT NULL AND stop_reason IN "
    "('no_consent', 'consent_withdrawn', 'boundary_changed', 'suspended', "
    "'provider_refused', 'vault_unavailable')) "
    "OR (state <> 'stopped' AND stop_reason IS NULL)"
)
FINISHED_CONDITION = (
    "(state = 'running' AND finished_at IS NULL) "
    "OR (state <> 'running' AND finished_at IS NOT NULL)"
)
LEASE_CONDITION = (
    "(owner_id IS NULL AND heartbeat_at IS NULL) "
    "OR (owner_id IS NOT NULL AND heartbeat_at IS NOT NULL)"
)
COUNTS_CONDITION = (
    "entries_total >= 0 AND entries_offered >= 0 "
    "AND entries_sorted >= 0 AND entries_sorted <= entries_offered"
)
RUNNING_CONDITION = "state = 'running'"


def upgrade() -> None:
    """Create the run table, its newest-first index and its single-flight index."""
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("lane", sqlmodel.sql.sqltypes.AutoString(length=_LANE_WIDTH), nullable=False),
        sa.Column("state", sqlmodel.sql.sqltypes.AutoString(length=_STATE_WIDTH), nullable=False),
        sa.Column(
            "stop_reason",
            sqlmodel.sql.sqltypes.AutoString(length=_STOP_REASON_WIDTH),
            nullable=True,
        ),
        sa.Column("entries_total", sa.Integer(), nullable=False),
        sa.Column("entries_offered", sa.Integer(), nullable=False),
        sa.Column("entries_sorted", sa.Integer(), nullable=False),
        sa.Column("owner_id", sqlmodel.sql.sqltypes.AutoString(length=_OWNER_WIDTH), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(LANE_CONDITION, name="ck_corpussortrun_lane_valid"),
        sa.CheckConstraint(STATE_CONDITION, name="ck_corpussortrun_state_valid"),
        sa.CheckConstraint(STOP_REASON_CONDITION, name="ck_corpussortrun_stop_reason_valid"),
        sa.CheckConstraint(FINISHED_CONDITION, name="ck_corpussortrun_finished_at_valid"),
        sa.CheckConstraint(LEASE_CONDITION, name="ck_corpussortrun_lease_valid"),
        sa.CheckConstraint(COUNTS_CONDITION, name="ck_corpussortrun_counts_valid"),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
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
    """Drop the run table; it holds scheduling state, and corpussweep keeps the reach."""
    op.drop_index(_RUNNING_INDEX, table_name=_TABLE)
    op.drop_index(_USER_INDEX, table_name=_TABLE)
    op.drop_table(_TABLE)
