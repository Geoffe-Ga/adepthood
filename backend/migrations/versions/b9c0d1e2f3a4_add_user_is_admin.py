"""add user.is_admin column

Revision ID: b9c0d1e2f3a4
Revises: a8b9c0d1e2f3
Create Date: 2026-04-19 00:00:00.000000

Promotes admin identity to a first-class per-user flag.  Every existing and
new user starts with ``is_admin=False``; promote the initial operator with a
one-line UPDATE.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b9c0d1e2f3a4"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "a8b9c0d1e2f3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add ``user.is_admin`` with ``server_default=false`` and ``NOT NULL``."""
    op.add_column(
        "user",
        sa.Column(
            "is_admin",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    """Drop the ``user.is_admin`` column."""
    op.drop_column("user", "is_admin")
