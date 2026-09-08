"""Add the licensebinding table: one Gumroad sale, one active account.

Revision ID: a9b8c7d6e5f4
Revises: f2c7a1d9e4b6
Create Date: 2026-09-07 00:00:00.000000

Purely additive: creates ``licensebinding`` — one row per redeemed Gumroad
sale, pointing at the account that redeemed it (``ON DELETE CASCADE`` so a
deleted account releases its licence, ADR 0008 Decision 3) with a named
UNIQUE constraint on ``gumroad_sale_id`` that is the single-active-account
invariant of Decision 2. No foreign key to ``gumroadsale``: a signup can beat
the webhook. ``downgrade`` drops the index then the table.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a9b8c7d6e5f4"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "f2c7a1d9e4b6"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Mirrors ``models.license_binding._SALE_ID_MAX`` / ``_PRODUCT_ID_MAX``.
_SALE_ID_MAX = 255
_PRODUCT_ID_MAX = 255


def upgrade() -> None:
    """Create the binding table, its user index, and the sale-id UNIQUE."""
    op.create_table(
        "licensebinding",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("gumroad_sale_id", sa.String(length=_SALE_ID_MAX), nullable=False),
        sa.Column("product_id", sa.String(length=_PRODUCT_ID_MAX), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("gumroad_sale_id", name="uq_licensebinding_gumroad_sale_id"),
    )
    op.create_index(op.f("ix_licensebinding_user_id"), "licensebinding", ["user_id"])


def downgrade() -> None:
    """Drop the user index then the binding table."""
    op.drop_index(op.f("ix_licensebinding_user_id"), table_name="licensebinding")
    op.drop_table("licensebinding")
