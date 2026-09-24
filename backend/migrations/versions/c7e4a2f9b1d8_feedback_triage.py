"""add operator triage to beta feedback: status, duplicate link, notes, audit trail

Revision ID: c7e4a2f9b1d8
Revises: e3a9d1c4b6f2
Create Date: 2026-09-23 00:00:00.000000

Issue #2900. Three additions, all additive:

* ``feedbackreport`` gains ``status`` (NOT NULL, ``server_default 'new'`` --
  which is what backfills every report filed before triage existed -- and a
  sorted ``IN`` CHECK), a nullable self-referencing ``duplicate_of_id``
  (``ON DELETE SET NULL``), and the ``(status, created_at, id)`` index the
  inbox's default read walks.
* ``feedbacknote`` -- one private operator note per row, the body encrypted at
  rest like the report's own prose (``EncryptedString`` decorates ``Text``).
* ``feedbacktriageevent`` -- the append-only audit trail, one row per mutation.

Both new tables ``CASCADE`` with their report and ``SET NULL`` their actor, the
same story :mod:`domain.account_deletion` tells.

The downgrade **refuses while triage state exists**, in the spirit of
``b4d2e7a9c1f3``: dropping a note destroys prose an operator wrote, and dropping
the trail destroys the record of who changed what. Neither can be rolled
forward from anywhere. A database with no notes, no events, no duplicate links
and every report still ``new`` has nothing to lose and downgrades cleanly.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c7e4a2f9b1d8"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "e3a9d1c4b6f2"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_REPORT = "feedbackreport"
_NOTE = "feedbacknote"
_EVENT = "feedbacktriageevent"

# Sorted, exactly as ``models.feedback.enum_check`` renders them.
_STATUSES = ("closed", "new", "planned", "triaged")
_ACTIONS = ("duplicate_linked", "duplicate_unlinked", "note_added", "status_changed")

_STATUS_WIDTH = 20
_ACTION_WIDTH = 24
_STATE_WIDTH = 32

_DUPLICATE_FK = "fk_feedbackreport_duplicate_of_id_feedbackreport"
_DUPLICATE_INDEX = "ix_feedbackreport_duplicate_of_id"
_STATUS_INDEX = "ix_feedbackreport_status_created_at_id"
_STATUS_CHECK = "ck_feedbackreport_status_valid"


def _in_clause(column: str, values: "Sequence[str]") -> str:
    """``col IN ('a', 'b')``, the shape the account seeder reads permitted values from."""
    quoted = ", ".join(f"'{value}'" for value in values)
    return f"{column} IN ({quoted})"


def upgrade() -> None:
    """Add triage state to reports, and create the note and event tables."""
    with op.batch_alter_table(_REPORT) as batch_op:
        batch_op.add_column(
            sa.Column(
                "status",
                sa.String(length=_STATUS_WIDTH),
                nullable=False,
                server_default="new",
            )
        )
        batch_op.add_column(sa.Column("duplicate_of_id", sa.Integer(), nullable=True))
        batch_op.create_check_constraint(_STATUS_CHECK, _in_clause("status", _STATUSES))
        batch_op.create_foreign_key(
            _DUPLICATE_FK, _REPORT, ["duplicate_of_id"], ["id"], ondelete="SET NULL"
        )
        batch_op.create_index(_DUPLICATE_INDEX, ["duplicate_of_id"])
        batch_op.create_index(_STATUS_INDEX, ["status", "created_at", "id"])

    op.create_table(
        _NOTE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("report_id", sa.Integer(), nullable=False),
        sa.Column("author_admin_id", sa.Integer(), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["report_id"], [f"{_REPORT}.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["author_admin_id"], ["user.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_feedbacknote_report_id", _NOTE, ["report_id"])
    op.create_index("ix_feedbacknote_author_admin_id", _NOTE, ["author_admin_id"])

    op.create_table(
        _EVENT,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("report_id", sa.Integer(), nullable=False),
        sa.Column("actor_admin_id", sa.Integer(), nullable=True),
        sa.Column("action", sa.String(length=_ACTION_WIDTH), nullable=False),
        sa.Column("old_state", sa.String(length=_STATE_WIDTH), nullable=True),
        sa.Column("new_state", sa.String(length=_STATE_WIDTH), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            _in_clause("action", _ACTIONS), name="ck_feedbacktriageevent_action_valid"
        ),
        sa.ForeignKeyConstraint(["report_id"], [f"{_REPORT}.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["actor_admin_id"], ["user.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_feedbacktriageevent_report_id", _EVENT, ["report_id"])
    op.create_index("ix_feedbacktriageevent_actor_admin_id", _EVENT, ["actor_admin_id"])


def _triage_state_count() -> int:
    """How many rows of operator-authored state a downgrade would destroy."""
    bind = op.get_bind()
    queries = (
        f"SELECT COUNT(*) FROM {_NOTE}",
        f"SELECT COUNT(*) FROM {_EVENT}",
        f"SELECT COUNT(*) FROM {_REPORT} WHERE status <> 'new' OR duplicate_of_id IS NOT NULL",
    )
    return sum(int(bind.execute(sa.text(query)).scalar_one()) for query in queries)


def downgrade() -> None:
    """Drop triage -- but refuse while any operator has recorded anything."""
    existing = _triage_state_count()
    if existing:
        msg = (
            f"Cannot downgrade: {existing} row(s) of feedback triage state still exist "
            "(notes, audit events, duplicate links or non-new statuses). Dropping them "
            "would destroy operator notes and the audit trail with no way to roll "
            "forward. Clear the triage state first."
        )
        raise RuntimeError(msg)
    op.drop_index("ix_feedbacktriageevent_actor_admin_id", table_name=_EVENT)
    op.drop_index("ix_feedbacktriageevent_report_id", table_name=_EVENT)
    op.drop_table(_EVENT)
    op.drop_index("ix_feedbacknote_author_admin_id", table_name=_NOTE)
    op.drop_index("ix_feedbacknote_report_id", table_name=_NOTE)
    op.drop_table(_NOTE)
    with op.batch_alter_table(_REPORT) as batch_op:
        batch_op.drop_index(_STATUS_INDEX)
        batch_op.drop_index(_DUPLICATE_INDEX)
        batch_op.drop_constraint(_DUPLICATE_FK, type_="foreignkey")
        batch_op.drop_constraint(_STATUS_CHECK, type_="check")
        batch_op.drop_column("duplicate_of_id")
        batch_op.drop_column("status")
