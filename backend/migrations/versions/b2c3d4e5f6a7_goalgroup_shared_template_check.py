"""add CHECK constraint on goalgroup shared_template/user_id

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-04-16 00:01:00.000000

BUG-GOAL-004: The shared-template invariant (shared_template=True implies
user_id IS NULL, and vice versa) was enforced only at the application layer.
A direct INSERT or future refactor could violate it.  This migration adds a
DB-level CHECK constraint to make the invariant a database guarantee.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b2c3d4e5f6a7"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_CONSTRAINT_NAME = "ck_goalgroup_shared_template_user_id"


def upgrade() -> None:
    """Add CHECK constraint tying shared_template to user_id."""
    op.create_check_constraint(
        _CONSTRAINT_NAME,
        "goalgroup",
        "(shared_template = true AND user_id IS NULL) "
        "OR (shared_template = false AND user_id IS NOT NULL)",
    )


def downgrade() -> None:
    """Drop the shared_template/user_id CHECK constraint."""
    op.drop_constraint(_CONSTRAINT_NAME, "goalgroup", type_="check")
