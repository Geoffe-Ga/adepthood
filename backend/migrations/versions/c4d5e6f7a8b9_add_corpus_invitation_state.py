"""Add the per-account corpus-invitation state (#2407).

Revision ID: c4d5e6f7a8b9
Revises: f2c7a1d9e4b6
Create Date: 2026-09-07 00:00:00.000000

Purely additive: ``upgrade`` creates ``corpusinvitationstate`` -- one row per
account recording how many Resonance passes it has completed, when it last set
the corpus invitation aside, the pass count at that instant, and whether it
asked not to be asked again -- with its cascading owner FK, the unique index
that makes it one row per account, and the two named CHECKs keeping the
counters non-negative. No backfill: rows are provisioned on the first
completed pass. ``downgrade`` drops the index then the table. No ``ALTER`` /
``DROP`` against existing tables.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c4d5e6f7a8b9"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "f2c7a1d9e4b6"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "corpusinvitationstate"
_USER_INDEX = "ix_corpusinvitationstate_user_id"


def upgrade() -> None:
    """Create the ``corpusinvitationstate`` table, its unique owner index and CHECKs."""
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("completed_passes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("passes_at_dismissal", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("dismissed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("do_not_ask_again", sa.Boolean(), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "completed_passes >= 0", name="ck_corpusinvitationstate_completed_passes_range"
        ),
        sa.CheckConstraint(
            "passes_at_dismissal >= 0",
            name="ck_corpusinvitationstate_passes_at_dismissal_range",
        ),
    )
    # One row per account: the service's get-or-create leans on this index to
    # lose a provisioning race safely rather than duplicating state.
    op.create_index(_USER_INDEX, _TABLE, ["user_id"], unique=True)


def downgrade() -> None:
    """Drop the ``corpusinvitationstate`` index then the table."""
    op.drop_index(_USER_INDEX, table_name=_TABLE)
    op.drop_table(_TABLE)
