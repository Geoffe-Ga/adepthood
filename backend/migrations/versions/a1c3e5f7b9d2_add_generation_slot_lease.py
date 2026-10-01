"""Add generationslot, the per-user concurrent generation lease (#623).

Revision ID: a1c3e5f7b9d2
Revises: e7a3c5f1d902
Create Date: 2026-10-01 00:00:00.000000

The owner ratified "maximum 2 concurrent generations/user" (decision record
§1, ``prompts/claude-comms/2026-09-05-resonance-economy-decision.md``). The cap
has to hold across workers, so it is a lease table rather than an in-process
semaphore: one row per held slot, and ``UNIQUE(user_id, slot)`` makes the
third concurrent acquire fail on any worker. ``expires_at`` lets a crashed
worker's lease be reclaimed.

Purely additive: ``upgrade`` creates the table, its owner index and the
unique constraint; ``downgrade`` drops them. A lease is transient, so the
downgrade discards any held rows without loss.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a1c3e5f7b9d2"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "e7a3c5f1d902"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "generationslot"
_USER_INDEX = "ix_generationslot_user_id"
_USER_SLOT_UNIQUE = "uq_generationslot_user_slot"


def upgrade() -> None:
    """Create ``generationslot`` with its cascading owner FK and unique slot pair."""
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("slot", sa.Integer(), nullable=False),
        sa.Column("acquired_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "slot", name=_USER_SLOT_UNIQUE),
    )
    op.create_index(_USER_INDEX, _TABLE, ["user_id"])


def downgrade() -> None:
    """Drop the owner index then the table (its unique constraint goes with it)."""
    op.drop_index(_USER_INDEX, table_name=_TABLE)
    op.drop_table(_TABLE)
