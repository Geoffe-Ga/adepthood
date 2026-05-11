"""add userpractice.custom_name + userpractice.mode_config_override

Revision ID: f0a1b2c3d4e5
Revises: e9f0a1b2c3d4
Create Date: 2026-05-11 01:00:00.000000

ritual-03: lets a user rename their selected practice ("My Morning Sit")
and override individual mode_config fields (duration, BPM, prompts, …)
without mutating the shared ``Practice`` catalog row.

Both columns are nullable; ``None`` means "use the catalog value". The
API resolver in :mod:`domain.practice_resolution` collapses
``(practice, user_practice)`` into ``effective_name`` and
``effective_config`` so frontend code never has to merge by hand.

The override is intentionally not allowed to change ``mode`` itself —
mode-shifting is a replacement, not a tweak.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f0a1b2c3d4e5"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "e9f0a1b2c3d4"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add the two nullable columns; no backfill required."""
    op.add_column(
        "userpractice",
        sa.Column("custom_name", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "userpractice",
        sa.Column("mode_config_override", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    """Drop both columns."""
    # Use batch_alter_table for SQLite compatibility (no inline ALTER COLUMN).
    with op.batch_alter_table("userpractice") as batch_op:
        batch_op.drop_column("mode_config_override")
        batch_op.drop_column("custom_name")
