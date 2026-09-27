"""add idempotency keys to journal creates and weekly-prompt responses

Revision ID: 6e6fe6af2c30
Revises: d5b8e2a4c1f7
Create Date: 2026-09-27 00:00:00.000000

Issue #2936. ``journalentry`` and ``promptresponse`` each gain a nullable
``idem_key`` -- the SHA-256 digest of ``(user_id, Idempotency-Key)``, never the
raw header -- behind a partial UNIQUE index on ``(user_id, idem_key)`` that
constrains only non-NULL keys, so unkeyed writes (every row that exists today)
never collide. The one-table shape of ``feedbackreport`` (``b4d2e7a9c1f3``):
the deduplicated object *is* the created row, so a companion table would buy a
second deletion and export policy for nothing.

The journal index is deliberately not partial on ``deleted_at``: a key whose
entry was since deleted stays spent, so a late retry cannot write the deleted
words again.

Purely additive, and the downgrade drops only retry bookkeeping.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "6e6fe6af2c30"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "d5b8e2a4c1f7"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# ``security.idempotency.IDEMPOTENCY_DIGEST_COLUMN_WIDTH`` at the time of
# writing. Spelled here rather than imported: a migration is a frozen record of
# the DDL it ran, and one that followed a live constant would silently rewrite
# history if the constant ever moved. ``alembic check`` pins the two together.
_DIGEST_COLUMN_WIDTH = 128
_COLUMN = "idem_key"
_KEYED_ONLY = f"{_COLUMN} IS NOT NULL"

# (table, index) for each keyed surface.
_TARGETS = (
    ("journalentry", "ix_journalentry_user_idem_key"),
    ("promptresponse", "ix_promptresponse_user_idem_key"),
)


def upgrade() -> None:
    """Add each nullable ``idem_key`` column and its partial unique index."""
    for table, index in _TARGETS:
        with op.batch_alter_table(table) as batch_op:
            batch_op.add_column(
                sa.Column(_COLUMN, sa.String(length=_DIGEST_COLUMN_WIDTH), nullable=True)
            )
        op.create_index(
            index,
            table,
            ["user_id", _COLUMN],
            unique=True,
            postgresql_where=sa.text(_KEYED_ONLY),
            sqlite_where=sa.text(_KEYED_ONLY),
        )


def downgrade() -> None:
    """Drop each index, then its column."""
    for table, index in reversed(_TARGETS):
        op.drop_index(index, table_name=table)
        with op.batch_alter_table(table) as batch_op:
            batch_op.drop_column(_COLUMN)
