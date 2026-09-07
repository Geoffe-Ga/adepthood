"""Add the durable one-shot habit auto-reveal marker.

Revision ID: f2c7a1d9e4b6
Revises: e9a4c6d8f0b2
Create Date: 2026-09-07 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f2c7a1d9e4b6"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "e9a4c6d8f0b2"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add a nullable marker without consuming existing invitations."""
    op.add_column(
        "habit",
        sa.Column("auto_revealed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    """Remove the one-shot marker."""
    op.drop_column("habit", "auto_revealed_at")
