"""add stageprogress.past_cycle_anchors so begin-again stops destroying the calendar.

Revision ID: a1f7c2b9d604
Revises: d4e7c9a1b830
Create Date: 2026-09-16 00:00:00.000000

``POST /stages/begin-again`` re-stamps ``program_started_at`` in place, which is
correct for the INCOMING cycle and catastrophic for the outgoing one: it was the
only record of when that cycle began, so every review written during it lost the
window it was written about (issue #2894). This adds a nullable JSON array in
which element ``i`` is cycle ``i + 1``'s program start, and the loop now appends
the outgoing anchor before bumping the cycle.

What this backfill does, and pointedly does not do
--------------------------------------------------
For a row already at ``cycle_number > 1`` the anchors of cycles 1..n-1 are GONE.
There is no stageprogress history or audit table, so nothing here can restore
them. The backfill records HOW MANY were destroyed — ``[None] * (cycle_number -
1)`` — and refuses to reconstruct a single one of them.

Two approximations were available and both are deliberately refused:

* ``MIN(habit.start_date)``, the source the original ``program_started_at``
  backfill used (``18c9d0e1f2a3``). Habits provably survive begin-again, so that
  query still returns a date — a plausible-looking WRONG date, which would
  fabricate a window and re-create the wrong-period defect of #2886 under a new
  name.
* The timestamps of surviving ``c1:wN`` reflection rows, which bound the anchor
  without determining it.

Recording unknown is the honest answer: the API reports ``anchor_status =
"unrecorded"`` for those cycles and the client says the period cannot be rebuilt.
Only cycles closed AFTER this ships carry a real window. Please do not "improve"
this backfill later by guessing.

Drift
-----
The ``server_default``-then-drop dance of ``f2a3b4c5d6e8`` exists to populate a
NOT NULL column; it does not apply here. A nullable column with no server default
is drift-free by construction: autogenerate compares name, type, nullability and
server default, and all four match ``StageProgress.past_cycle_anchors`` exactly.
The precedent is ``c7d8e9f0a1b3``'s ``journalentry.vault_tags`` — the same
``sa.JSON()``-nullable-no-default shape — with ``18c9d0e1f2a3`` for the nullable
anchor column itself. ``alembic check`` proves it in the ``migration-drift`` CI
job, which is the only place it runs (it needs a live Postgres); this suite's
round-trip test is the local equivalent guard, as the comment above the
``c7d8e9f0a1b3`` section of ``tests/test_migrations.py`` explains.

``downgrade()`` drops the column, which discards every anchor retained since the
upgrade. That loss is irreversible — the data has no other home.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a1f7c2b9d604"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "d4e7c9a1b830"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE_NAME = "stageprogress"
_COLUMN_NAME = "past_cycle_anchors"

# The first cycle leaves nothing behind, so a row that never looped needs no
# record at all and keeps NULL.
_FIRST_CYCLE = 1

# Both statements are fixed literals over this module's own table: nothing from
# a request, a row, or an environment is interpolated into either one. Only the
# bound parameters vary, and ``value`` is bound through ``sa.JSON()`` so each
# dialect renders the array its own way.
_SELECT_LOOPED_ROWS = sa.text(
    "SELECT id, cycle_number FROM stageprogress WHERE cycle_number > :first"
)
_RECORD_UNKNOWN_ANCHORS = sa.text(
    "UPDATE stageprogress SET past_cycle_anchors = :value WHERE id = :id"
).bindparams(sa.bindparam("value", type_=sa.JSON()))


def upgrade() -> None:
    """Add the nullable JSON column and record each destroyed anchor as unknown.

    The backfill runs in Python over the bound connection rather than as one
    dialect-specific UPDATE, so it behaves identically on SQLite and Postgres:
    the JSON array is bound through ``sa.JSON()``, which each dialect renders in
    its own way.
    """
    op.add_column(_TABLE_NAME, sa.Column(_COLUMN_NAME, sa.JSON(), nullable=True))

    connection = op.get_bind()
    looped_rows = connection.execute(_SELECT_LOOPED_ROWS, {"first": _FIRST_CYCLE}).all()
    for row_id, cycle_number in looped_rows:
        connection.execute(
            _RECORD_UNKNOWN_ANCHORS,
            {"value": [None] * (cycle_number - _FIRST_CYCLE), "id": row_id},
        )


def downgrade() -> None:
    """Drop the column (batch mode keeps ``DROP COLUMN`` SQLite-compatible).

    Every anchor retained since the upgrade is discarded and cannot be rebuilt.
    """
    with op.batch_alter_table(_TABLE_NAME) as batch_op:
        batch_op.drop_column(_COLUMN_NAME)
