"""add promptresponse.prompt_ordinal

Revision ID: b7d2e5f10a34
Revises: a4c7e91b3d05
Create Date: 2026-08-21 00:00:00.000000

Records *which* of a stage's prompts a weekly response answers. A stage carries
three to five prompts across three or six weeks, so ``week_number`` alone stops
identifying a prompt as soon as a client can address more than the one the week
happens to draw.

Nullable on purpose, and it stays nullable: every row written before this column
existed answered whatever prompt its week drew, and that is still derivable from
the week. ``NULL`` therefore means "the prompt this week draws", which is both
the historically true reading and the reading a client that omits the field
keeps getting. Backfilling a number instead would freeze today's rotation into
rows that never asserted it.

The ``(user_id, week_number)`` unique constraint is deliberately untouched: one
response per week is still the pacing rule, and the ordinal says which prompt
that one response addressed — it does not open four submissions per week.

``downgrade`` drops the column.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b7d2e5f10a34"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "a4c7e91b3d05"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE_NAME = "promptresponse"
_COLUMN_NAME = "prompt_ordinal"


def upgrade() -> None:
    """Add the nullable 1-based prompt ordinal to stored responses."""
    op.add_column(_TABLE_NAME, sa.Column(_COLUMN_NAME, sa.Integer(), nullable=True))


def downgrade() -> None:
    """Drop the prompt ordinal; every row falls back to the prompt its week draws."""
    op.drop_column(_TABLE_NAME, _COLUMN_NAME)
