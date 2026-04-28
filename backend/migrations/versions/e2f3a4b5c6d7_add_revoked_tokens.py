"""add revokedtoken table

Revision ID: e2f3a4b5c6d7
Revises: f1a2b3c4d5e6
Create Date: 2026-04-28 21:00:00.000000

Persists JWT ``jti`` claims that have been explicitly revoked (e.g. by
``/auth/refresh``).  ``get_current_user`` consults this table on every
authenticated request so a stolen-and-refreshed token can no longer be
replayed for the rest of its original ``exp`` window (BUG-AUTH-013).

Tokens minted before this column existed have no ``jti`` and are
treated as legacy-but-valid for the duration of their 1-hour TTL — the
required grace window for the JWT-shape change so existing sessions
don't all 401 at once on deploy.

The table is small by construction (one row per refresh, expires with
the original token's ``exp``).  An index on ``expires_at`` lets a
periodic cleanup job prune past-due rows efficiently; the primary-key
index on ``jti`` carries the per-request lookup.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e2f3a4b5c6d7"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "f1a2b3c4d5e6"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create the ``revokedtoken`` table."""
    op.create_table(
        "revokedtoken",
        sa.Column("jti", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("jti"),
    )
    op.create_index(
        "ix_revokedtoken_expires_at",
        "revokedtoken",
        ["expires_at"],
    )


def downgrade() -> None:
    """Drop the ``revokedtoken`` table."""
    op.drop_index("ix_revokedtoken_expires_at", table_name="revokedtoken")
    op.drop_table("revokedtoken")
