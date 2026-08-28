"""The sweep log arrives and the grant's own count leaves.

Revision ID: 4e1a9c72bd60
Revises: b1c2d3e4f5a7
Create Date: 2026-08-25 00:00:00.000000

A grant's reach into an account's existing writing is bounded, so it stops with
a remainder, and a repeated ``PUT`` of an answer already given appends no second
decision but does re-run the sweep over what is left. One count on the decision
row therefore describes only the *first* of the sweeps that decision authorises.
``corpussweep`` is one row per sweep -- what it considered, what it added, what
it left, and the decision it ran under -- so the running total a permission
eventually reached is a query rather than a guess.

``corpusconsentevent.fragments_added`` goes in the same migration rather than
being left in place as a convenience. A first-of-many sitting beside a log of
all of them is a second source of truth, and the less true one: an operator
reading it would be told a grant reached two entries when the account's three
later sweeps reached forty more. ``fragments_removed`` stays, because a
revocation's purge really does happen once, inside the decision.

``downgrade`` restores the column's **shape but not its values.** It comes back
NOT NULL with every row backfilled to 0, which is a deliberate and bounded
destruction of audit evidence. Bounded three ways: the numbers were emitted by
``services.corpus_backfill``'s own log line as each sweep ran and survive there
for the retention window; the same facts for every sweep after the first were
never in that column to begin with; and the count stays derivable from
``corpusfragment`` itself, whose rows carry the account and the instant they
were written, so what a grant reached between one decision and the next can be
recovered by counting them. Fabricating the two counts the column never held
would have been the worse repair -- invented audit numbers are a defect where
recoverable ones are an inconvenience.

The same downgrade drops ``corpussweep`` entirely, which destroys strictly more
than the column does and has only the log line behind it. That is the ordinary
cost of reversing a migration that created a table, and it is stated here rather
than left to be discovered: this is an emergency path, not a supported way to
run.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "4e1a9c72bd60"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "b1c2d3e4f5a7"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_SWEEP_TABLE = "corpussweep"
_SWEEP_USER_INDEX = "ix_corpussweep_user_id_id"
_SWEEP_CONSENT_INDEX = "ix_corpussweep_consent_event_id"

_CONSENT_TABLE = "corpusconsentevent"
_ADDED_COLUMN = "fragments_added"
_ADDED_CHECK = "ck_corpusconsentevent_fragments_added_range"
_ADDED_CONDITION = "fragments_added >= 0"

# Rows written before the column was dropped have no count to put back, and
# "reached nothing" is the only value a restore can honestly assert. Temporary:
# the model owns the default, so the DB-level one is cleared straight after, or
# ``alembic check`` reports drift.
_ADDED_BACKFILL = "0"


def upgrade() -> None:
    """Create the sweep log, then retire the count it replaces."""
    op.create_table(
        _SWEEP_TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("consent_event_id", sa.Integer(), nullable=False),
        sa.Column("entries_considered", sa.Integer(), nullable=False),
        sa.Column("fragments_added", sa.Integer(), nullable=False),
        sa.Column("entries_remaining", sa.Integer(), nullable=False),
        sa.Column("swept_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "entries_considered >= 0",
            name="ck_corpussweep_entries_considered_range",
        ),
        sa.CheckConstraint(
            "fragments_added >= 0",
            name="ck_corpussweep_fragments_added_range",
        ),
        sa.CheckConstraint(
            "entries_remaining >= 0",
            name="ck_corpussweep_entries_remaining_range",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["consent_event_id"], [f"{_CONSENT_TABLE}.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(_SWEEP_USER_INDEX, _SWEEP_TABLE, ["user_id", "id"])
    op.create_index(_SWEEP_CONSENT_INDEX, _SWEEP_TABLE, ["consent_event_id"])
    # One batch block takes the CHECK and the column together, so both backends
    # are driven by the same op calls: SQLite (the round-trip test) rebuilds the
    # table because it can drop neither in place, PostgreSQL emits two ALTERs.
    # The resulting schema is the same either way, which is the point.
    with op.batch_alter_table(_CONSENT_TABLE) as batch_op:
        batch_op.drop_constraint(_ADDED_CHECK, type_="check")
        batch_op.drop_column(_ADDED_COLUMN)


def downgrade() -> None:
    """Put the column's shape back -- values backfilled to 0 -- and drop the log."""
    op.add_column(
        _CONSENT_TABLE,
        sa.Column(_ADDED_COLUMN, sa.Integer(), nullable=False, server_default=_ADDED_BACKFILL),
    )
    with op.batch_alter_table(_CONSENT_TABLE) as batch_op:
        batch_op.alter_column(
            _ADDED_COLUMN,
            existing_type=sa.Integer(),
            existing_nullable=False,
            server_default=None,
        )
        batch_op.create_check_constraint(_ADDED_CHECK, _ADDED_CONDITION)
    op.drop_index(_SWEEP_CONSENT_INDEX, table_name=_SWEEP_TABLE)
    op.drop_index(_SWEEP_USER_INDEX, table_name=_SWEEP_TABLE)
    op.drop_table(_SWEEP_TABLE)
