"""unique lower(email) index

Revision ID: e8376b41c6a1
Revises: 78b1620cafde
Create Date: 2026-04-15 00:00:00.000000

Guards against case-only duplicate signups (BUG-AUTH-003). The application
now normalizes emails to ``strip().lower()`` at the request boundary, but a
case-sensitive unique constraint would still permit pre-existing duplicates
to coexist. A functional unique index on ``lower(email)`` makes the
invariant a database-level guarantee, not just an application convention.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e8376b41c6a1"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "78b1620cafde"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_UNIQUE_LOWER_EMAIL_INDEX = "ix_user_lower_email_unique"


def upgrade() -> None:
    """Add a case-insensitive unique index on ``user.email``."""
    op.execute(
        f'CREATE UNIQUE INDEX "{_UNIQUE_LOWER_EMAIL_INDEX}" '
        'ON "user" (lower(email))'
    )


def downgrade() -> None:
    """Drop the case-insensitive unique index."""
    op.execute(f'DROP INDEX IF EXISTS "{_UNIQUE_LOWER_EMAIL_INDEX}"')
