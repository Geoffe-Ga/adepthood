"""Add llmusagelog.generation_id and llmusagelog.charged (#623 PR3).

Revision ID: c4e6a8b0d2f1
Revises: a1c3e5f7b9d2
Create Date: 2026-10-01 00:00:00.000000

The ratified record asks to "alert/revisit pricing if p95 provider cost
approaches 3.5¢ per charged generation" (§2 of
``prompts/claude-comms/2026-09-05-resonance-economy-decision.md``). A usage row
is one provider call, and a resonance pass with a corrective retry and its
detection dial writes several, so the table cannot price a *generation*
without a key that groups those calls, nor tell a server-paid one from BYOK.

Purely additive: two nullable columns and an index on ``generation_id``. A row
written before this revision keeps ``NULL`` in both, which the admin metric
reads as "not keyed" and excludes rather than guessing. ``downgrade`` drops the
index and both columns; the usage rows themselves are untouched. Wrapped in
``batch_alter_table`` so the SQLite round trip rebuilds the table while
Postgres emits plain ``ALTER TABLE`` statements.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c4e6a8b0d2f1"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "a1c3e5f7b9d2"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "llmusagelog"
_GENERATION_ID = "generation_id"
_CHARGED = "charged"
_INDEX = "ix_llmusagelog_generation_id"
# A ``uuid4().hex`` -- see ``models.llm_usage_log.GENERATION_ID_LENGTH``.
_GENERATION_ID_LENGTH = 32


def upgrade() -> None:
    """Add the nullable generation key, the charged flag, and the key's index."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.add_column(
            sa.Column(_GENERATION_ID, sa.String(length=_GENERATION_ID_LENGTH), nullable=True)
        )
        batch_op.add_column(sa.Column(_CHARGED, sa.Boolean(), nullable=True))
        batch_op.create_index(_INDEX, [_GENERATION_ID])


def downgrade() -> None:
    """Drop the index and both columns; every usage row survives."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_index(_INDEX)
        batch_op.drop_column(_CHARGED)
        batch_op.drop_column(_GENERATION_ID)
