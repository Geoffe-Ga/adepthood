"""link a habit to the writing timer: useruiflags.writing_session_habit_id

Revision ID: d5b8e2a4c1f7
Revises: c7e4a2f9b1d8
Create Date: 2026-09-27 00:00:00.000000

Issue #2861. One additive, nullable column on ``useruiflags`` naming the habit
a finished writing session checks off. ``ON DELETE SET NULL`` so deleting that
habit unlinks the timer rather than blocking the delete or taking the user's
flags row with it; indexed because that delete looks rows up by it.

No backfill: every existing row starts unlinked, which is the truth -- nobody
has chosen a habit yet. The downgrade drops the column, forgetting only which
habit a writer had linked; the habit and its check-ins are untouched, and the
link can be chosen again from Settings.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d5b8e2a4c1f7"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "c7e4a2f9b1d8"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "useruiflags"
_COLUMN = "writing_session_habit_id"
_FK = "fk_useruiflags_writing_session_habit_id_habit"
_INDEX = "ix_useruiflags_writing_session_habit_id"


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
