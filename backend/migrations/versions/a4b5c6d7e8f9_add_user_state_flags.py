"""add user.is_active, email_verified, deleted_at

Revision ID: a4b5c6d7e8f9
Revises: f3a4b5c6d7e8
Create Date: 2026-04-28 23:00:00.000000

BUG-MODEL-001: the User row had no soft-disable / verification /
soft-delete surface.  Adding three columns here lets the auth and
admin layers gate users without hard-deleting rows:

  * ``is_active`` -- ``NOT NULL`` with ``server_default=true`` so
    every existing user remains active.
  * ``email_verified`` -- ``NOT NULL`` with ``server_default=false``
    so existing users land in the unverified state and start to flow
    through whatever verification UX ships next.
  * ``deleted_at`` -- nullable timestamp; ``NULL`` means "not deleted".

Reversible.  All three column additions are safe on a live DB --
``server_default`` populates existing rows during the ALTER, no
backfill required.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a4b5c6d7e8f9"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "f3a4b5c6d7e8"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add ``is_active``, ``email_verified``, ``deleted_at`` to ``user``."""
    op.add_column(
        "user",
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.add_column(
        "user",
        sa.Column(
            "email_verified",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "user",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    """Drop the three account-state columns."""
    op.drop_column("user", "deleted_at")
    op.drop_column("user", "email_verified")
    op.drop_column("user", "is_active")
