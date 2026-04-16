"""cascade goal.habit_id and goalcompletion.goal_id

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-04-16 00:01:00.000000

BUG-HABITS-004: Deleting a habit should cascade to its goals and their
completions so orphan rows cannot linger in the database.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b2c3d4e5f6a7"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Replace FK constraints with CASCADE variants."""
    # goal.habit_id -> habit.id CASCADE
    op.execute('ALTER TABLE goal DROP CONSTRAINT IF EXISTS "goal_habit_id_fkey"')
    op.execute(
        "ALTER TABLE goal "
        "ADD CONSTRAINT goal_habit_id_fkey "
        "FOREIGN KEY (habit_id) REFERENCES habit(id) ON DELETE CASCADE"
    )

    # goalcompletion.goal_id -> goal.id CASCADE
    op.execute(
        'ALTER TABLE goalcompletion DROP CONSTRAINT IF EXISTS "goalcompletion_goal_id_fkey"'
    )
    op.execute(
        "ALTER TABLE goalcompletion "
        "ADD CONSTRAINT goalcompletion_goal_id_fkey "
        "FOREIGN KEY (goal_id) REFERENCES goal(id) ON DELETE CASCADE"
    )


def downgrade() -> None:
    """Restore FK constraints without CASCADE."""
    # goalcompletion.goal_id
    op.execute('ALTER TABLE goalcompletion DROP CONSTRAINT IF EXISTS "goalcompletion_goal_id_fkey"')
    op.execute(
        "ALTER TABLE goalcompletion "
        "ADD CONSTRAINT goalcompletion_goal_id_fkey "
        "FOREIGN KEY (goal_id) REFERENCES goal(id)"
    )

    # goal.habit_id
    op.execute('ALTER TABLE goal DROP CONSTRAINT IF EXISTS "goal_habit_id_fkey"')
    op.execute(
        "ALTER TABLE goal "
        "ADD CONSTRAINT goal_habit_id_fkey "
        "FOREIGN KEY (habit_id) REFERENCES habit(id)"
    )
