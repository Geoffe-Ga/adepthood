"""Keep an un-enrolled writer's provider key encrypted for background classification (R1-1).

Revision ID: 8c4e2b7d1a95
Revises: 5d3c8a1f9b27
Create Date: 2026-11-01

Owner decision R1-1 (2026-10-27) with the split confirmed on 2026-11-01:
un-enrolled accounts' BYOK key may be stored server-decryptable, encrypted at
rest, scoped to background vault classification; enrolled accounts keep theirs
user-held. ADR 0009's "Amendment 2026-11-01" is the record.

One row per account, cascading with it. ``api_key`` is the same ciphertext
column type every other secret at rest uses (``EncryptedString`` over ``Text``),
and ``provider`` is a closed vocabulary. No backfill: the table starts empty and
fills only as a writer's key is relayed for a classification admission. The
downgrade drops the table, and with it every stored key, which returns every
account to the keyless background behaviour that preceded it.
"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "8c4e2b7d1a95"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "5d3c8a1f9b27"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "vaultclassificationkey"


def upgrade() -> None:
    """Create the one-row-per-account stored-key table."""
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("provider", sqlmodel.sql.sqltypes.AutoString(length=16), nullable=False),
        sa.Column("api_key", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "provider IN ('anthropic', 'openai')",
            name="ck_vaultclassificationkey_provider_valid",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id"),
    )


def downgrade() -> None:
    """Drop the table, deleting every stored key."""
    op.drop_table(_TABLE)
