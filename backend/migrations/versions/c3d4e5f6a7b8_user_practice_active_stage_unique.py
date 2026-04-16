"""user_practice active stage unique index

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-04-16 00:02:00.000000

BUG-PRACTICE-011: Prevents multiple active (end_date IS NULL) user-practice
rows for the same user + stage combination.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c3d4e5f6a7b8"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "b2c3d4e5f6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_INDEX_NAME = "ix_user_practice_active_stage"


def upgrade() -> None:
    """Add partial unique index on (user_id, stage_number) WHERE end_date IS NULL."""
    op.execute(
        f'CREATE UNIQUE INDEX "{_INDEX_NAME}" '
        "ON userpractice (user_id, stage_number) WHERE end_date IS NULL"
    )


def downgrade() -> None:
    """Drop the partial unique index."""
    op.execute(f'DROP INDEX IF EXISTS "{_INDEX_NAME}"')
