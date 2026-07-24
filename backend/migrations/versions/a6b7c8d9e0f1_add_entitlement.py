"""Add the entitlement table for per-user course-access grants.

Revision ID: a6b7c8d9e0f1
Revises: d0e1f2a3b4c6
Create Date: 2026-07-22 00:00:00.000000

Purely additive: creates ``entitlement`` — one row per grant of an access
kind (today only ``course_access``) with lifecycle timestamps, a nullable
provenance link to the funding ``gumroadsale`` row (no ondelete cascade:
deleting a sale must never silently revoke access), and a JSON ``metadata``
extensibility bag. The partial unique index on ``(user_id, kind)`` WHERE
``revoked_at IS NULL`` allows at most one active grant per user per kind
while keeping revoked history. ``downgrade`` drops the indexes then the
table.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a6b7c8d9e0f1"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "d0e1f2a3b4c6"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Mirrors ``models.entitlement._KIND_MAX``.
_KIND_MAX = 32


def upgrade() -> None:
    """Create the entitlement table, its kind CHECK, and both indexes."""
    op.create_table(
        "entitlement",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=_KIND_MAX), nullable=False),
        sa.Column("product_id", sa.String(), nullable=True),
        sa.Column("source_sale_id", sa.Integer(), nullable=True),
        sa.Column("granted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("metadata", sa.JSON(), nullable=False),
        sa.CheckConstraint("kind IN ('course_access')", name="ck_entitlement_kind_valid"),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_sale_id"], ["gumroadsale.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_entitlement_user_id"), "entitlement", ["user_id"])
    # Partial unique index: at most one active (``revoked_at IS NULL``)
    # entitlement per (user, kind), while revoked history rows may pile up so
    # revoke-then-regrant always works.
    op.create_index(
        "ix_entitlement_user_kind_active",
        "entitlement",
        ["user_id", "kind"],
        unique=True,
        postgresql_where=sa.text("revoked_at IS NULL"),
        sqlite_where=sa.text("revoked_at IS NULL"),
    )


def downgrade() -> None:
    """Drop the entitlement indexes then the table."""
    op.drop_index("ix_entitlement_user_kind_active", table_name="entitlement")
    op.drop_index(op.f("ix_entitlement_user_id"), table_name="entitlement")
    op.drop_table("entitlement")
