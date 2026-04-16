"""convert datetime columns to timestamptz

Revision ID: 78b1620cafde
Revises: 145d340640ce
Create Date: 2026-04-13 22:30:00.000000

Converts every ``TIMESTAMP WITHOUT TIME ZONE`` column to
``TIMESTAMP WITH TIME ZONE`` so the application's timezone-aware UTC
datetimes can be bound by asyncpg.  Existing naive values are reinterpreted
as UTC via the ``USING ... AT TIME ZONE 'UTC'`` clause — safe because the
application has always written ``datetime.now(UTC)``.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "78b1620cafde"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "145d340640ce"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (table, column) pairs that should be converted.  Order doesn't matter.
_DATETIME_COLUMNS: tuple[tuple[str, str], ...] = (
    ("loginattempt", "created_at"),
    ("user", "monthly_reset_date"),
    ("user", "created_at"),
    ("promptresponse", "timestamp"),
    ("stageprogress", "stage_started_at"),
    ("contentcompletion", "completed_at"),
    ("goalcompletion", "timestamp"),
    ("practicesession", "timestamp"),
    ("journalentry", "timestamp"),
    ("llmusagelog", "timestamp"),
)


def upgrade() -> None:
    """Upgrade schema."""
    for table, column in _DATETIME_COLUMNS:
        op.alter_column(
            table,
            column,
            type_=sa.DateTime(timezone=True),
            existing_type=sa.DateTime(timezone=False),
            existing_nullable=False,
            postgresql_using=f'"{column}" AT TIME ZONE \'UTC\'',
        )


def downgrade() -> None:
    """Downgrade schema.

    BUG-INFRA-022: align the downgrade expression with the upgrade so
    ``alembic downgrade -1`` succeeds.  ``column AT TIME ZONE 'UTC'`` on a
    ``TIMESTAMP WITH TIME ZONE`` value yields a ``TIMESTAMP WITHOUT TIME ZONE``
    in UTC, which is exactly the inverse of the upgrade conversion.
    """
    for table, column in _DATETIME_COLUMNS:
        op.alter_column(
            table,
            column,
            type_=sa.DateTime(timezone=False),
            existing_type=sa.DateTime(timezone=True),
            existing_nullable=False,
            postgresql_using=f'"{column}" AT TIME ZONE \'UTC\'',
        )
