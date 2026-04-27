"""add user.timezone column

Revision ID: d1e2f3a4b5c6
Revises: c0d1e2f3a4b5
Create Date: 2026-04-27 00:00:00.000000

Stores the user's IANA timezone (e.g. ``"America/Los_Angeles"``) so
streak / daily-completion math can compute "today" in the user's local
calendar instead of UTC.  Closes the BUG-STREAK-002 / BUG-HABIT-006 /
BUG-GOAL-004 family — see ``backend/src/domain/dates.py``.

The column is ``NOT NULL`` with ``server_default='UTC'`` so existing
rows backfill automatically and the default is preserved across pure
``INSERT`` statements that don't list the column.  64 chars covers the
longest IANA name in tzdata (``America/Argentina/ComodRivadavia`` is
33; allowing 64 leaves headroom for future entries without DDL churn).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d1e2f3a4b5c6"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "c0d1e2f3a4b5"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add ``user.timezone`` with ``server_default='UTC'`` and ``NOT NULL``."""
    op.add_column(
        "user",
        sa.Column(
            "timezone",
            sa.String(length=64),
            nullable=False,
            server_default="UTC",
        ),
    )


def downgrade() -> None:
    """Drop the ``user.timezone`` column."""
    op.drop_column("user", "timezone")
