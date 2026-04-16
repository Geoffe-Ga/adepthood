"""add ondelete SET NULL on goal.goal_group_id

Revision ID: a1b2c3d4e5f6
Revises: e8376b41c6a1
Create Date: 2026-04-16 00:00:00.000000

BUG-GOAL-003: Deleting a GoalGroup should SET NULL on Goal.goal_group_id
rather than leaving orphaned FK references.  The application-level unlink
in the delete handler already does this, but without the DB constraint a
direct DELETE or future refactor could break referential integrity.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a1b2c3d4e5f6"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "e8376b41c6a1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Replace the goal.goal_group_id FK with ondelete=SET NULL."""
    op.drop_constraint("goal_goal_group_id_fkey", "goal", type_="foreignkey")
    op.create_foreign_key(
        "goal_goal_group_id_fkey",
        "goal",
        "goalgroup",
        ["goal_group_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    """Revert to FK without ondelete."""
    op.drop_constraint("goal_goal_group_id_fkey", "goal", type_="foreignkey")
    op.create_foreign_key(
        "goal_goal_group_id_fkey",
        "goal",
        "goalgroup",
        ["goal_group_id"],
        ["id"],
    )
