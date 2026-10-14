"""Add the detached, content-free journal withdrawal note (#3267).

Revision ID: 15c817227402
Revises: c4e6a8b0d2f4
Create Date: 2026-10-14 00:00:00.000000

``journalwithdrawalnote`` is what an open ``journalwithdrawalobligation``
becomes when its account is deleted: the vault's opaque fingerprint, the entry
id and the detachment instant, with no ``user_id``, no foreign key and no
content. Owner decision (2026-10-14): keep it until the vault confirms, for at
most 97 days.

A new table rather than a nullable ``user_id`` on the obligation: the
obligation's (account, entry) uniqueness, its lifecycle states and its cascade
all describe a live account, and a row that can name nobody is a different
record with a different lifetime.

Purely additive with no backfill: before this revision account deletion erased
every obligation, so no deleted account has one left to detach. ``downgrade``
drops the table. Widths are frozen at this revision rather than imported from
``src``.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "15c817227402"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "c4e6a8b0d2f4"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "journalwithdrawalnote"

# Width frozen at this revision (mirrors models.journal_entry.VAULT_DESTINATION_WIDTH).
_DESTINATION_WIDTH = 32


def upgrade() -> None:
    """Create the note table with its per-entry uniqueness and its purge index."""
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("journal_entry_id", sa.Integer(), nullable=False),
        sa.Column("destination", sa.String(length=_DESTINATION_WIDTH), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_journalwithdrawalnote_entry_unique", _TABLE, ["journal_entry_id"], unique=True
    )
    op.create_index("ix_journalwithdrawalnote_created_at", _TABLE, ["created_at"])


def downgrade() -> None:
    """Drop the note table; no other table changes."""
    op.drop_index("ix_journalwithdrawalnote_created_at", table_name=_TABLE)
    op.drop_index("ix_journalwithdrawalnote_entry_unique", table_name=_TABLE)
    op.drop_table(_TABLE)
