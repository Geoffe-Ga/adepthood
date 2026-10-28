"""The authorization server for vault agents gets its three tables.

Revision ID: bc3e90210168
Revises: b2c3d4e5f6a8
Create Date: 2026-10-24 00:00:00.000000

Adepthood becomes the OAuth 2.1 authorization server a person's vault agents
sign in through (#3532). Three tables carry that:

* ``oauth_client`` -- every agent that registered (RFC 7591) or is described by
  its own client metadata document. Public clients only, so no secret column.
  Anonymous by design: nothing here points at ``user``.
* ``oauth_authorization_code`` -- one row per approval, holding the SHA-256 of
  a one-time code and everything the approval bound it to (client, redirect,
  PKCE challenge, vault resource, scopes, account). Spent once by the token
  endpoint (#3533) or expired within a minute.
* ``agent_grant`` -- one row per (account, agent): the grants the person
  approved, and when they were last used or revoked. What Settings lists and
  revokes (#3534).

Both account-linked tables cascade on the account's deletion, so erasing an
account erases what it approved. Both point at ``oauth_client.client_id``
with a cascade too, so a client removed from the registry takes its unspent
codes and grants with it.

``downgrade`` drops all three, which forgets every registered agent and every
approval: each agent has to register again and each person approve again.
Nothing a person wrote is lost -- none of these rows holds any.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "bc3e90210168"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "b2c3d4e5f6a8"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CLIENT = "oauth_client"
_CODE = "oauth_authorization_code"
_GRANT = "agent_grant"

# The model-side widths, restated because a migration must not import models.
_URI = 2048
_CLIENT_NAME = 100
_SOURCE = 8
_CODE_HASH = 64
_CHALLENGE = 128
_CHALLENGE_METHOD = 8
_SCOPE = 256


def _timestamp(name: str, *, nullable: bool) -> sa.Column[sa.DateTime]:
    """Return a timezone-aware timestamp column, the shape every model here declares."""
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def upgrade() -> None:
    """Create the client registry, the code table and the grant table."""
    op.create_table(
        _CLIENT,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("client_id", sa.String(length=_URI), nullable=False),
        sa.Column("client_name", sa.String(length=_CLIENT_NAME), nullable=False),
        sa.Column("logo_uri", sa.String(length=_URI), nullable=True),
        sa.Column("redirect_uris", sa.JSON(), nullable=False),
        sa.Column("source", sa.String(length=_SOURCE), nullable=False),
        _timestamp("created_at", nullable=False),
        _timestamp("metadata_fetched_at", nullable=True),
        sa.CheckConstraint("source IN ('dcr', 'cimd')", name="ck_oauth_client_source"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_oauth_client_client_id", _CLIENT, ["client_id"], unique=True)

    op.create_table(
        _CODE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("code_hash", sa.String(length=_CODE_HASH), nullable=False),
        sa.Column("client_id", sa.String(length=_URI), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("redirect_uri", sa.String(length=_URI), nullable=False),
        sa.Column("code_challenge", sa.String(length=_CHALLENGE), nullable=False),
        sa.Column("code_challenge_method", sa.String(length=_CHALLENGE_METHOD), nullable=False),
        sa.Column("resource", sa.String(length=_URI), nullable=False),
        sa.Column("scope", sa.String(length=_SCOPE), nullable=False),
        _timestamp("created_at", nullable=False),
        _timestamp("expires_at", nullable=False),
        _timestamp("consumed_at", nullable=True),
        sa.ForeignKeyConstraint(["client_id"], [f"{_CLIENT}.client_id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_oauth_authorization_code_code_hash", _CODE, ["code_hash"], unique=True
    )
    op.create_index("ix_oauth_authorization_code_user_id", _CODE, ["user_id"])

    op.create_table(
        _GRANT,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("client_id", sa.String(length=_URI), nullable=False),
        sa.Column("grants", sa.JSON(), nullable=False),
        sa.Column("resource", sa.String(length=_URI), nullable=False),
        _timestamp("created_at", nullable=False),
        _timestamp("last_used_at", nullable=True),
        _timestamp("revoked_at", nullable=True),
        sa.ForeignKeyConstraint(["client_id"], [f"{_CLIENT}.client_id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "client_id", name="uq_agent_grant_user_client"),
    )
    op.create_index("ix_agent_grant_user_id", _GRANT, ["user_id"])


def downgrade() -> None:
    """Drop all three tables: every agent registers again and every person approves again."""
    op.drop_index("ix_agent_grant_user_id", table_name=_GRANT)
    op.drop_table(_GRANT)
    op.drop_index("ix_oauth_authorization_code_user_id", table_name=_CODE)
    op.drop_index("ix_oauth_authorization_code_code_hash", table_name=_CODE)
    op.drop_table(_CODE)
    op.drop_index("ix_oauth_client_client_id", table_name=_CLIENT)
    op.drop_table(_CLIENT)
