"""Add user.display_name for the name a social sign-in supplies.

Revision ID: b0c1d2e3f4a5
Revises: e6f7a8b9c0d1
Create Date: 2026-07-28 00:00:00.000000

Issue #1949: Sign in with Apple sends the user's name exactly once, in the
body of the very first authorization, and never again -- so it has to be
persisted at account creation or it is gone for good. Google sends the same
thing as a verified ``name`` claim. Both land in one column.

Purely additive and nullable: existing rows keep the ``NULL`` that means "no
name supplied", which is the steady state for every password signup, so no
backfill is needed and every reader already carries a fallback. There is no
server default -- the model owns the ``None`` default, which keeps
``alembic check`` drift-free. ``downgrade`` drops the column.
"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b0c1d2e3f4a5"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "e6f7a8b9c0d1"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "user"
_COLUMN = "display_name"

# Mirrors ``models.user.DISPLAY_NAME_MAX_LENGTH``.
_DISPLAY_NAME_MAX = 120


def upgrade() -> None:
    """Add the nullable ``display_name`` column."""
    op.add_column(
        _TABLE,
        sa.Column(
            _COLUMN,
            sqlmodel.sql.sqltypes.AutoString(length=_DISPLAY_NAME_MAX),
            nullable=True,
        ),
    )


def downgrade() -> None:
    """Drop the ``display_name`` column."""
    # Batch mode keeps the DROP COLUMN SQLite-compatible for the round-trip test.
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_column(_COLUMN)
