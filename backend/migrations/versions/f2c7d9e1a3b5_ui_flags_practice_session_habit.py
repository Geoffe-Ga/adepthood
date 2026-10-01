"""link a habit to practice sessions: useruiflags.practice_session_habit_id

Revision ID: f2c7d9e1a3b5
Revises: c4e6a8b0d2f1
Create Date: 2026-10-01 00:00:00.000000

The practice-screen twin of ``d5b8e2a4c1f7`` (#2861): one additive, nullable
column on ``useruiflags`` naming the habit a finished practice session checks
off. ``ON DELETE SET NULL`` so deleting that habit unlinks the practice screen
rather than blocking the delete or taking the user's flags row with it;
indexed because that delete looks rows up by it.

No backfill: every existing row starts unlinked, which is the truth -- nobody
has chosen a habit yet. The downgrade drops the column, forgetting only which
habit was linked; the habit and its check-ins are untouched, and the link can
be chosen again from Settings.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f2c7d9e1a3b5"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "c4e6a8b0d2f1"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "useruiflags"
_COLUMN = "practice_session_habit_id"
_FK = "fk_useruiflags_practice_session_habit_id_habit"
_INDEX = "ix_useruiflags_practice_session_habit_id"


def upgrade() -> None:
    """Add the nullable, indexed habit link with ``ON DELETE SET NULL``."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.add_column(sa.Column(_COLUMN, sa.Integer(), nullable=True))
        batch_op.create_foreign_key(_FK, "habit", [_COLUMN], ["id"], ondelete="SET NULL")
        batch_op.create_index(_INDEX, [_COLUMN])


def downgrade() -> None:
    """Drop the habit link; every other flag on the row is kept."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_index(_INDEX)
        batch_op.drop_constraint(_FK, type_="foreignkey")
        batch_op.drop_column(_COLUMN)
