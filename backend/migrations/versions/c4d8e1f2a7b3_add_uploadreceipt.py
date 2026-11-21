"""Keep a receipt for every document an account sends to its vault.

Revision ID: c4d8e1f2a7b3
Revises: e6a1d3b9c5f2
Create Date: 2026-11-20 00:00:00.000000

``POST /corpus/import`` answers a vault upload with its destination, status and
vault ref, and nothing persisted them, so "did my files land?" had no answer
after the request (#3775). ``uploadreceipt`` holds one row per settled vault
import (a ``vault_busy`` refusal is a wait, not a settlement, and earns none): the filename, a digest of the folder import's namespace (never the
namespace itself), the digest id the upload
was addressed by, Creek's opaque ref, and the two closed vocabularies. No
document content is stored.

The vocabularies are frozen here rather than imported from ``src``, so this
revision means the same thing forever; they match the model's CHECKs.
``downgrade`` drops the table, which only forgets receipts: every document they
describe is still in the vault.
"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c4d8e1f2a7b3"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "e6a1d3b9c5f2"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "uploadreceipt"
_INDEX = "ix_uploadreceipt_user_id_id"

# Frozen at this revision (mirror domain.corpus_import.ImportDestination and
# models.upload_receipt.RECEIPT_VAULT_STATUSES: every VaultUploadStatus except
# ``vault_busy``, a wait after which the same document is sent again).
_DESTINATIONS = ("vault", "corpus")
FROZEN_VAULT_STATUSES = (
    "accepted",
    "vault_unavailable",
    "capability_unsupported",
    "degraded",
    "unsupported_source",
)

_FILENAME_WIDTH = 255
_BATCH_WIDTH = 16
_EXTERNAL_ID_WIDTH = 64
_VAULT_REF_WIDTH = 512
_VOCABULARY_WIDTH = 32


def _in(column: str, values: Sequence[str]) -> str:
    """The CHECK body admitting exactly ``values`` in ``column``."""
    return "{} IN ({})".format(column, ", ".join(f"'{value}'" for value in values))


def upgrade() -> None:
    """Create the receipt table and its one read index."""
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column(
            "filename", sqlmodel.sql.sqltypes.AutoString(length=_FILENAME_WIDTH), nullable=False
        ),
        sa.Column("batch", sqlmodel.sql.sqltypes.AutoString(length=_BATCH_WIDTH), nullable=True),
        sa.Column(
            "external_id",
            sqlmodel.sql.sqltypes.AutoString(length=_EXTERNAL_ID_WIDTH),
            nullable=False,
        ),
        sa.Column(
            "vault_ref", sqlmodel.sql.sqltypes.AutoString(length=_VAULT_REF_WIDTH), nullable=True
        ),
        sa.Column(
            "destination",
            sqlmodel.sql.sqltypes.AutoString(length=_VOCABULARY_WIDTH),
            nullable=False,
        ),
        sa.Column(
            "vault_status",
            sqlmodel.sql.sqltypes.AutoString(length=_VOCABULARY_WIDTH),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            _in("destination", _DESTINATIONS), name="ck_uploadreceipt_destination_valid"
        ),
        sa.CheckConstraint(
            _in("vault_status", FROZEN_VAULT_STATUSES), name="ck_uploadreceipt_vault_status_valid"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(_INDEX, _TABLE, ["user_id", "id"], unique=False)


def downgrade() -> None:
    """Forget every receipt."""
    op.drop_index(_INDEX, table_name=_TABLE)
    op.drop_table(_TABLE)
