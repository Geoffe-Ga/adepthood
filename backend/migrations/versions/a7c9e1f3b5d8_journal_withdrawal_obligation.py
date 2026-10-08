"""Add the durable, content-free journal withdrawal obligation (#3098, #3094).

Revision ID: a7c9e1f3b5d8
Revises: f5539c70e00d
Create Date: 2026-10-08 00:00:00.000000

``journalwithdrawalobligation`` records that a journal page's vault copy is
still owed a withdrawal: ``pending_delete`` (the writer asked to delete the
page and the vault has not confirmed yet; the background sweep finishes it),
``unconfirmed`` (the writer could not reach the vault holding the copy and
deleted the page here anyway), or ``confirmed``. Ids, a closed state, an opaque
destination fingerprint and timestamps only. ``journal_entry_id`` is not a
foreign key so the obligation outlives any purge of the local row.

Purely additive with no backfill: before this revision a DELETE the vault did
not confirm left the page live, so there is no half-finished deletion to
recover. ``downgrade`` drops the table. The state vocabulary is frozen at this
revision rather than imported from ``src``.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a7c9e1f3b5d8"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "f5539c70e00d"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "journalwithdrawalobligation"

# Widths and vocabulary frozen at this revision (mirrored by
# models.journal_withdrawal_obligation and models.journal_entry).
_STATE_WIDTH = 16
_DESTINATION_WIDTH = 32
_STATES = ("pending_delete", "unconfirmed", "confirmed")


def upgrade() -> None:
    """Create the obligation table with its closed state and indexes."""
    states = ", ".join(f"'{state}'" for state in _STATES)
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("user.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("journal_entry_id", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(length=_STATE_WIDTH), nullable=False),
        sa.Column("destination", sa.String(length=_DESTINATION_WIDTH), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            f"state IN ({states})", name="ck_journalwithdrawalobligation_state_valid"
        ),
    )
    op.create_index(
        "ix_journalwithdrawalobligation_user_entry_unique",
        _TABLE,
        ["user_id", "journal_entry_id"],
        unique=True,
    )
    op.create_index("ix_journalwithdrawalobligation_state", _TABLE, ["state"])


def downgrade() -> None:
    """Drop the obligation table; no other table changes."""
    op.drop_index("ix_journalwithdrawalobligation_state", table_name=_TABLE)
    op.drop_index("ix_journalwithdrawalobligation_user_entry_unique", table_name=_TABLE)
    op.drop_table(_TABLE)
