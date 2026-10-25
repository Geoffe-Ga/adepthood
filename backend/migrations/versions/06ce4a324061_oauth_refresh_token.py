"""Vault agents get rotating refresh tokens.

Revision ID: 06ce4a324061
Revises: bc3e90210168
Create Date: 2026-10-24 12:00:00.000000

The token endpoint (#3533) trades an authorization code for a ten-minute access
token and a thirty-day refresh token, and every refresh rotates the refresh
token. ``oauth_refresh_token`` holds one row per refresh token ever issued:
only its SHA-256, the rotation family it belongs to, the grant it was issued
under, and when it was rotated away or revoked. A rotated row is kept until its
own expiry so that presenting it again is recognised as reuse and revokes the
family.

Rows cascade with their grant and with their account, so revoking an agent's
grant by deleting it, or erasing the account, takes every refresh token with it.

``downgrade`` drops the table, which ends every agent's session: each agent has
to send its person through approval again. Nothing a person wrote is lost.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "06ce4a324061"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "bc3e90210168"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "oauth_refresh_token"

# The model-side widths, restated because a migration must not import models.
_TOKEN_HASH = 64
_FAMILY_ID = 32


def _timestamp(name: str, *, nullable: bool) -> sa.Column[sa.DateTime]:
    """Return a timezone-aware timestamp column, the shape every model here declares."""
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def upgrade() -> None:
    """Create the refresh token table and its lookup indexes."""
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("token_hash", sa.String(length=_TOKEN_HASH), nullable=False),
        sa.Column("family_id", sa.String(length=_FAMILY_ID), nullable=False),
        sa.Column("grant_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        _timestamp("created_at", nullable=False),
        _timestamp("expires_at", nullable=False),
        _timestamp("rotated_at", nullable=True),
        _timestamp("revoked_at", nullable=True),
        sa.ForeignKeyConstraint(["grant_id"], ["agent_grant.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(f"ix_{_TABLE}_token_hash", _TABLE, ["token_hash"], unique=True)
    op.create_index(f"ix_{_TABLE}_family_id", _TABLE, ["family_id"])
    op.create_index(f"ix_{_TABLE}_grant_id", _TABLE, ["grant_id"])
    op.create_index(f"ix_{_TABLE}_user_id", _TABLE, ["user_id"])


def downgrade() -> None:
    """Drop the table: every agent signs in again."""
    op.drop_index(f"ix_{_TABLE}_user_id", table_name=_TABLE)
    op.drop_index(f"ix_{_TABLE}_grant_id", table_name=_TABLE)
    op.drop_index(f"ix_{_TABLE}_family_id", table_name=_TABLE)
    op.drop_index(f"ix_{_TABLE}_token_hash", table_name=_TABLE)
    op.drop_table(_TABLE)
