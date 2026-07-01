"""add user_depth_preferences table

Revision ID: e2f3a4b5c6d8
Revises: d8e9f0a1b2c3
Create Date: 2026-06-30 00:00:00.000000

Adds ``userdepthpreferences`` — one row per user recording which optional
program rings (habits, practices, course, sangha) the user has enabled.
``upgrade`` creates the table with all four boolean flags ``NOT NULL`` and a
DB-level ``server_default`` of true (mirroring the model's ``server_default`` so
``alembic check`` stays drift-free), a unique FK to ``user.id`` with
``ON DELETE CASCADE``, then backfills every existing user with an all-True row.
``downgrade`` drops the table.

The revision ID ``e2f3a4b5c6d8`` was chosen because the id the test's
placeholder originally named collided with an in-tree migration; the test
constant ``_USER_DEPTH_PREFS_REVISION`` was updated to match this real id.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e2f3a4b5c6d8"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "d8e9f0a1b2c3"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE_NAME = "userdepthpreferences"
_BACKFILL = sa.text(
    "INSERT INTO userdepthpreferences"
    " (user_id, enable_habits, enable_practices, enable_course, enable_sangha)"
    ' SELECT id, true, true, true, true FROM "user"'
)


def upgrade() -> None:
    """Create ``userdepthpreferences`` and backfill a row per existing user."""
    op.create_table(
        _TABLE_NAME,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("enable_habits", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("enable_practices", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("enable_course", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("enable_sangha", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id"),
    )
    op.execute(_BACKFILL)


def downgrade() -> None:
    """Drop the ``userdepthpreferences`` table."""
    op.drop_table(_TABLE_NAME)
