"""Add the per-reader set-aside of a stage prompt (#2726).

Revision ID: f2a3b4c5d6e7
Revises: c4d5e6f7a8b9
Create Date: 2026-09-09 00:00:00.000000

Purely additive: ``upgrade`` creates ``promptdismissal`` -- one row per
``(reader, stage, prompt)`` the reader has set aside -- with its cascading
owner FK, the unique index that makes a repeat set-aside idempotent, and the
non-unique owner index that keeps "this reader's dismissals" a range scan. No
backfill: an absent row is the whole default, since nothing is set aside until
a reader says so. ``downgrade`` drops the indexes then the table. No ``ALTER``
/ ``DROP`` against existing tables -- in particular nothing touches
``promptresponse``, because a dismissal is a preference and never a completion.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f2a3b4c5d6e7"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "c4d5e6f7a8b9"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "promptdismissal"
_PROMPT_INDEX = "ix_prompt_dismissal_user_prompt"
_USER_INDEX = "ix_prompt_dismissal_user_id"


def upgrade() -> None:
    """Create the ``promptdismissal`` table and its two indexes."""
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("stage_number", sa.Integer(), nullable=False),
        sa.Column("prompt_ordinal", sa.Integer(), nullable=False),
        sa.Column("dismissed_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    # One dismissal per (reader, stage, prompt): a double tap or a retried
    # request collapses onto the row that already exists rather than adding a
    # second one the undo would then have to delete twice.
    op.create_index(
        _PROMPT_INDEX,
        _TABLE,
        ["user_id", "stage_number", "prompt_ordinal"],
        unique=True,
    )
    op.create_index(_USER_INDEX, _TABLE, ["user_id"])


def downgrade() -> None:
    """Drop the ``promptdismissal`` indexes then the table."""
    op.drop_index(_USER_INDEX, table_name=_TABLE)
    op.drop_index(_PROMPT_INDEX, table_name=_TABLE)
    op.drop_table(_TABLE)
