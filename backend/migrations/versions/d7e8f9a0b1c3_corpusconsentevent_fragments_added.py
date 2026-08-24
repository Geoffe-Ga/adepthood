"""Add corpusconsentevent.fragments_added, the grant's half of the receipt.

Revision ID: d7e8f9a0b1c3
Revises: a6b7c8d9e0f2
Create Date: 2026-08-22 00:00:00.000000

A grant used to be a no-op against the corpus, so one count -- how many
fragments a revocation removed -- described everything a decision could reach.
A grant now ontologizes the writing the account already had, so it reaches the
corpus in the other direction and needs the other count.

Deliberately a second column rather than a widened first one: the two
directions are different events, and making ``fragments_removed`` sometimes
mean "added" would put the number an operator most needs to trust -- how much
writing a withdrawal actually deleted -- behind knowing which decision the row
records.

``upgrade`` adds it NOT NULL with a temporary ``server_default='0'`` so rows
written before this migration backfill to "reached nothing", which is true of
every one of them, then drops the server default (the app owns it via the
model's ``Field`` default, keeping ``alembic check`` drift-free) and installs
the ``>= 0`` CHECK that mirrors ``__table_args__``. Nothing existing is
rewritten and no consent decision changes meaning.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d7e8f9a0b1c3"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "a6b7c8d9e0f2"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE_NAME = "corpusconsentevent"
_COLUMN_NAME = "fragments_added"
_ADDED_CHECK = "ck_corpusconsentevent_fragments_added_range"
_ADDED_CONDITION = "fragments_added >= 0"


def upgrade() -> None:
    """Add ``fragments_added`` (NOT NULL, backfilled 0) and its CHECK."""
    op.add_column(
        _TABLE_NAME,
        sa.Column(_COLUMN_NAME, sa.Integer(), nullable=False, server_default="0"),
    )
    # One batch rebuild drops the DB-level default and installs the CHECK, so
    # SQLite (round-trip test) and PostgreSQL take the same path.
    with op.batch_alter_table(_TABLE_NAME) as batch_op:
        batch_op.alter_column(
            _COLUMN_NAME,
            existing_type=sa.Integer(),
            existing_nullable=False,
            server_default=None,
        )
        batch_op.create_check_constraint(_ADDED_CHECK, _ADDED_CONDITION)


def downgrade() -> None:
    """Drop the CHECK and the column."""
    with op.batch_alter_table(_TABLE_NAME) as batch_op:
        batch_op.drop_constraint(_ADDED_CHECK, type_="check")
        batch_op.drop_column(_COLUMN_NAME)
