"""Add the gumroadsale table for verbatim Gumroad ping persistence.

Revision ID: d0e1f2a3b4c6
Revises: c2d3e4f5a6b7
Create Date: 2026-07-22 00:00:00.000000

Creates ``gumroadsale``: one row per received Gumroad ping webhook, keyed by
Gumroad's ``sale_id`` (unique index — webhook replays collapse onto the
existing row). ``raw_payload`` stores the posted form verbatim as JSON so
later features (license grants, refund handling) can re-derive anything the
typed columns don't cover. Purely additive; ``downgrade`` drops the index and
table.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d0e1f2a3b4c6"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "c2d3e4f5a6b7"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the gumroadsale table with a unique index on gumroad_sale_id."""
    op.create_table(
        "gumroadsale",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("gumroad_sale_id", sa.String(), nullable=False),
        sa.Column("product_id", sa.String(), nullable=False),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("resource_name", sa.String(), nullable=False),
        sa.Column("is_recurring_charge", sa.Boolean(), nullable=False),
        sa.Column("refunded", sa.Boolean(), nullable=False),
        sa.Column("raw_payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_gumroadsale_gumroad_sale_id"),
        "gumroadsale",
        ["gumroad_sale_id"],
        unique=True,
    )


def downgrade() -> None:
    """Drop the gumroadsale table and its unique index."""
    op.drop_index(op.f("ix_gumroadsale_gumroad_sale_id"), table_name="gumroadsale")
    op.drop_table("gumroadsale")
