"""convert goal.tier to a constrained enum

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-04-16 00:02:00.000000

BUG-GOAL-006: goal.tier previously accepted any string.  This migration adds
a CHECK constraint limiting the value to the GoalTier enum members
('low', 'clear', 'stretch').

We use a CHECK constraint instead of a PostgreSQL ENUM type because:
  1. Adding new enum members to PG ENUM requires ALTER TYPE ... ADD VALUE
     inside a transaction, which interacts poorly with Alembic's
     transactional DDL.
  2. A CHECK is easier to extend later and equally effective for three
     values.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c3d4e5f6a7b8"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "b2c3d4e5f6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_CONSTRAINT_NAME = "ck_goal_tier_valid"


def upgrade() -> None:
    """Add CHECK constraint on goal.tier."""
    op.create_check_constraint(
        _CONSTRAINT_NAME,
        "goal",
        "tier IN ('low', 'clear', 'stretch')",
    )


def downgrade() -> None:
    """Drop the tier CHECK constraint."""
    op.drop_constraint(_CONSTRAINT_NAME, "goal", type_="check")
