"""add uservaultconfig table

Revision ID: d5e6f7a8b9c0
Revises: c3d4e5f6a7b9
Create Date: 2026-08-21 00:00:00.000000

Adds ``uservaultconfig`` — one row per account naming the Creek Vault that
account connected and holding the credential that opens it. This is what moves
vault configuration off the deployment's environment, where at most one user
could ever be the vault's owner, and onto the account, where every user can
reach a vault that is already theirs alone.

``api_key`` is ``TEXT`` rather than a bounded string, and that is a consequence
of the column type rather than a choice about credential length: the value is
written through ``EncryptedString``, so what lands here is a Fernet token about
1.3x the plaintext plus the ``enc::v1::`` marker. The ceiling on the credential
itself is enforced at the request boundary, which also refuses anything an
``Authorization`` header could not carry.

The unique constraint on ``user_id`` is the invariant, not an index for speed:
one account has at most one vault, so connecting a second time replaces the
first and no two rows can ever disagree about where an account's writing goes.
It also serves the lookup, which is the only read this table has — one row by
account, on every request that touches a vault.

``ON DELETE CASCADE`` matches the account-deletion policy's ``erase``
disposition for this table: a deleted account's stored third-party credential
goes with it.

``downgrade`` drops the table.
"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d5e6f7a8b9c0"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "c3d4e5f6a7b9"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE_NAME = "uservaultconfig"

# Matches ``models.user_vault_config.VAULT_URL_MAX_LENGTH``.
_VAULT_URL_WIDTH = 2048


def upgrade() -> None:
    """Create the per-account vault-configuration table."""
    op.create_table(
        _TABLE_NAME,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column(
            "vault_url",
            sqlmodel.sql.sqltypes.AutoString(length=_VAULT_URL_WIDTH),
            nullable=False,
        ),
        sa.Column("api_key", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id"),
    )


def downgrade() -> None:
    """Drop the per-account vault-configuration table."""
    op.drop_table(_TABLE_NAME)
