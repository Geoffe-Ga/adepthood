"""add journalentry.vault_ref / vault_tags for the Creek Vault write path.

Revision ID: c7d8e9f0a1b3
Revises: f8a9b0c1d2e3
Create Date: 2026-07-10 00:00:00.000000

Adds two nullable columns to ``journalentry`` that link an entry to the Creek
Vault: ``vault_ref`` (the opaque handle a successful vault ingest returns) and
``vault_tags`` (the JSON array of Frequency / Wavelength-phase tags the vault
classified). Both are NULL for entries never sent to a vault -- intimate entries
and every entry written while no vault is configured -- so this is a purely
additive, non-destructive change. A plain nullable ``ADD COLUMN`` is SQLite-safe
without a batch rebuild; the downgrade drops both columns inside a
``batch_alter_table`` so ``DROP COLUMN`` also works on SQLite.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c7d8e9f0a1b3"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "f8a9b0c1d2e3"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE_NAME = "journalentry"
_VAULT_REF_COLUMN = "vault_ref"
_VAULT_TAGS_COLUMN = "vault_tags"


def upgrade() -> None:
    """Add the nullable ``vault_ref`` (String) and ``vault_tags`` (JSON) columns."""
    op.add_column(_TABLE_NAME, sa.Column(_VAULT_REF_COLUMN, sa.String(), nullable=True))
    op.add_column(_TABLE_NAME, sa.Column(_VAULT_TAGS_COLUMN, sa.JSON(), nullable=True))


def downgrade() -> None:
    """Drop both vault columns (batch mode keeps ``DROP COLUMN`` SQLite-compatible)."""
    with op.batch_alter_table(_TABLE_NAME) as batch_op:
        batch_op.drop_column(_VAULT_TAGS_COLUMN)
        batch_op.drop_column(_VAULT_REF_COLUMN)
