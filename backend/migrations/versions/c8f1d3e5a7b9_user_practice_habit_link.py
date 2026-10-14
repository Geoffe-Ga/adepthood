"""link a practice to a habit: userpractice.habit_id

Revision ID: c8f1d3e5a7b9
Revises: b6d8f0a2c4e6
Create Date: 2026-10-13 12:00:00.000000

Issue #3151. One additive, nullable column on ``userpractice`` naming the habit
that practice's sessions count toward -- one per selection, so two practices
can feed two habits. ``ON DELETE SET NULL`` so deleting that habit unlinks the
practice rather than blocking the delete or taking the selection with it;
indexed because that delete looks rows up by it.

No backfill: every existing selection starts unlinked, which is the truth --
nobody has chosen a habit for a practice yet. The downgrade drops the column,
forgetting only which habit each practice fed; the habit, the selection and
their histories are untouched.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c8f1d3e5a7b9"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "b6d8f0a2c4e6"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "userpractice"
_COLUMN = "habit_id"
_FK = "fk_userpractice_habit_id_habit"
_INDEX = "ix_userpractice_habit_id"


def upgrade() -> None:
    """Add the nullable, indexed habit link with ``ON DELETE SET NULL``."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.add_column(sa.Column(_COLUMN, sa.Integer(), nullable=True))
        batch_op.create_foreign_key(_FK, "habit", [_COLUMN], ["id"], ondelete="SET NULL")
        batch_op.create_index(_INDEX, [_COLUMN])


def downgrade() -> None:
    """Drop the habit link; every other field of each selection is kept."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_index(_INDEX)
        batch_op.drop_constraint(_FK, type_="foreignkey")
        batch_op.drop_column(_COLUMN)
