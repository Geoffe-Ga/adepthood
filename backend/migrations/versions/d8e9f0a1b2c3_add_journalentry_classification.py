"""add journalentry.classification privacy tier

Revision ID: d8e9f0a1b2c3
Revises: c5d6e7f8a9b0
Create Date: 2026-06-30 00:00:00.000000

Adds the privacy-tier column ``classification`` to ``journalentry``. ``upgrade``
adds it ``NOT NULL`` with a temporary ``server_default='personal'`` so existing
rows backfill to the default tier, then drops the server default (the app owns
the default, keeping ``alembic check`` drift-free), then installs a CHECK
pinning the value to {public, personal, intimate} — mirroring the constraint in
the model's ``__table_args__``. ``downgrade`` drops the CHECK and the column.
This is a data-model change only; routing/enforcement is issue #895.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d8e9f0a1b2c3"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "c5d6e7f8a9b0"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CLASSIFICATION_CHECK = "ck_journalentry_classification_valid"
_CLASSIFICATION_CONDITION = "classification IN ('public', 'personal', 'intimate')"


def upgrade() -> None:
    """Add ``journalentry.classification`` (NOT NULL, backfilled 'personal') + CHECK."""
    # Add with a server_default so the NOT NULL column backfills existing rows to
    # the default tier ('personal').
    op.add_column(
        "journalentry",
        sa.Column(
            "classification",
            sa.String(length=20),
            nullable=False,
            server_default="personal",
        ),
    )
    # Drop the DB-level server_default (the app owns the default via the model's
    # Field default, keeping ``alembic check`` drift-free) and install the CHECK
    # in a single batch rebuild so SQLite (round-trip test) stays compatible.
    with op.batch_alter_table("journalentry") as batch_op:
        batch_op.alter_column(
            "classification",
            existing_type=sa.String(length=20),
            existing_nullable=False,
            server_default=None,
        )
        batch_op.create_check_constraint(_CLASSIFICATION_CHECK, _CLASSIFICATION_CONDITION)


def downgrade() -> None:
    """Drop the classification CHECK and column."""
    # Batch mode keeps the downgrade SQLite-compatible (no ALTER/DROP CHECK there).
    with op.batch_alter_table("journalentry") as batch_op:
        batch_op.drop_constraint(_CLASSIFICATION_CHECK, type_="check")
        batch_op.drop_column("classification")
