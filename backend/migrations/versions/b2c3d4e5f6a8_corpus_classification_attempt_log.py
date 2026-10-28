"""The classification attempt log arrives, so the daily bound has rows to count.

Revision ID: b2c3d4e5f6a8
Revises: a1938b4c5d6e
Create Date: 2026-10-23 00:00:00.000000

Corpus classification is a server-paid provider call that reaches the wallet
nowhere, so none of the four ratified per-user guardrails counted it: not the
monthly cap, not the per-minute limit, not the concurrency lease, and not the
daily ceiling on charged generations. The only brake was the ambient per-IP
rate limit on whichever route triggered it, which a scripted client on a
consented account could ride for tens of thousands of calls a day.

``corpusclassificationattempt`` is one content-free row per call the app paid
for -- an account and an instant -- so the per-account daily bound is a query
over rows since 00:00 UTC rather than a counter somebody has to remember to
reset. That is the shape the charged-generation ceiling already uses over
``walletaudit``; see ``models.corpus_classification_attempt`` for why a row
rather than a counter on ``user``, and why an attempt rather than a stored
fragment.

``downgrade`` drops the table, which destroys the spending evidence it holds
and, more importantly, removes the bound's ability to count -- an account's
allowance reads as unspent the moment this is reversed. The log line
``services.corpus_ingest`` writes when the ceiling refuses survives in the
retention window either way. This is the ordinary cost of reversing a migration
that created a table, stated here rather than left to be discovered: an
emergency path, not a supported way to run.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b2c3d4e5f6a8"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "a1938b4c5d6e"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "corpusclassificationattempt"
_INDEX = "ix_corpusclassificationattempt_user_id_attempted_at"


def upgrade() -> None:
    """Create the attempt log the daily classification bound counts."""
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("attempted_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    # The filter and the range in one index, matching the model's own
    # declaration so ``alembic check`` sees no drift.
    op.create_index(_INDEX, _TABLE, ["user_id", "attempted_at"])


def downgrade() -> None:
    """Drop the log, which leaves every account's allowance reading as unspent."""
    op.drop_index(_INDEX, table_name=_TABLE)
    op.drop_table(_TABLE)
