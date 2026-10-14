"""add resourcecompletion table for Start Here read marks (#3148).

Revision ID: e0094da08afc
Revises: c8f1d3e5a7b9
Create Date: 2026-10-14 00:00:00.000000

Purely additive: ``upgrade`` creates the ``resourcecompletion`` table (a
user's read mark on a manifest site resource, keyed by slug because resources
are not database rows) with its cascading owner FK, the owner index, and the
``uq_resourcecompletion_user_slug`` constraint that makes mark-read idempotent
under concurrency. ``downgrade`` drops the index then the table. No ``ALTER``
or ``DROP`` against existing tables.
"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e0094da08afc"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "c8f1d3e5a7b9"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "resourcecompletion"
_USER_INDEX = "ix_resourcecompletion_user_id"
_SLUG_MAX_LENGTH = 100


def upgrade() -> None:
    """Create the ``resourcecompletion`` table, its constraint and owner index."""
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column(
            "slug",
            sqlmodel.sql.sqltypes.AutoString(length=_SLUG_MAX_LENGTH),
            nullable=False,
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "slug", name="uq_resourcecompletion_user_slug"),
    )
    op.create_index(_USER_INDEX, _TABLE, ["user_id"], unique=False)


def downgrade() -> None:
    """Drop the ``resourcecompletion`` owner index then the table."""
    op.drop_index(_USER_INDEX, table_name=_TABLE)
    op.drop_table(_TABLE)
