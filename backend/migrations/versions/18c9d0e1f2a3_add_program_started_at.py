"""add stageprogress.program_started_at program-wide anchor

Revision ID: 18c9d0e1f2a3
Revises: 07b8c9d0e1f2
Create Date: 2026-06-10 00:00:00.000000

Issue #386: gives the backend the single program-start anchor the
frontend (#384) already treats as canonical, so server-side stage/week
gating can derive the same date-based calendar instead of disagreeing
with what the user sees.

Backfill: existing users anchor on the earliest start date among their
habits — the same source the frontend's onboarding anchor uses — falling
back to ``stage_started_at`` (conservative: later for anyone past stage
1, which only makes the time gate stricter).  The column stays nullable
so ``resolve_program_anchor`` can fall back at read time for any row a
future code path creates without it.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "18c9d0e1f2a3"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "07b8c9d0e1f2"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add the nullable anchor column, then backfill from habit history."""
    op.add_column(
        "stageprogress",
        sa.Column("program_started_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Earliest habit start date per user (a DATE — midnight is the right
    # anchor semantics), else the per-stage timestamp.  A correlated
    # subquery keeps this portable across Postgres and SQLite.
    op.execute(
        sa.text(
            """
            UPDATE stageprogress
            SET program_started_at = COALESCE(
                (
                    SELECT MIN(habit.start_date)
                    FROM habit
                    WHERE habit.user_id = stageprogress.user_id
                ),
                stageprogress.stage_started_at
            )
            """
        )
    )


def downgrade() -> None:
    """Drop the anchor column; gating reverts to advancement/completion only."""
    op.drop_column("stageprogress", "program_started_at")
