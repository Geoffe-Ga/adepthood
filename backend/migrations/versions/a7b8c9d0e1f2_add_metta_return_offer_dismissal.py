"""add metta_return_offer_dismissal table for per-episode Return offer dismissal.

Revision ID: a7b8c9d0e1f2
Revises: a5b6c7d8e9f0
Create Date: 2026-07-02 00:00:00.000000

Purely additive: ``upgrade`` creates the ``mettareturnofferdismissal`` table (a
user's per-episode dismissal of the Return invitation) with its owner FK
(cascading), the unique index enforcing one dismissal per (user, episode) so
re-dismissing is idempotent, and the non-unique owner index. ``downgrade`` drops
the indexes then the table. No ``ALTER`` / ``DROP`` against existing tables.
"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a7b8c9d0e1f2"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "a5b6c7d8e9f0"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the ``mettareturnofferdismissal`` table and its indexes."""
    op.create_table(
        "mettareturnofferdismissal",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("episode_key", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("dismissed_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    # Unique index: one dismissal per (user, episode) so a repeat dismiss of the
    # same episode is idempotent rather than duplicating rows.
    op.create_index(
        "ix_metta_return_offer_dismissal_user_episode",
        "mettareturnofferdismissal",
        ["user_id", "episode_key"],
        unique=True,
    )
    op.create_index(
        "ix_metta_return_offer_dismissal_user_id",
        "mettareturnofferdismissal",
        ["user_id"],
    )


def downgrade() -> None:
    """Drop the ``mettareturnofferdismissal`` indexes then the table."""
    op.drop_index(
        "ix_metta_return_offer_dismissal_user_id",
        table_name="mettareturnofferdismissal",
    )
    op.drop_index(
        "ix_metta_return_offer_dismissal_user_episode",
        table_name="mettareturnofferdismissal",
    )
    op.drop_table("mettareturnofferdismissal")
