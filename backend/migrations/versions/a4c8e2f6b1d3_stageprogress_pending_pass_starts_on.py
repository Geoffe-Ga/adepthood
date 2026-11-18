"""Hold the day a pending pass will start on ``stageprogress``.

Revision ID: a4c8e2f6b1d3
Revises: 9d2b6e4f1a73
Create Date: 2026-11-17 00:00:00.000000

Energy Scaffolding may now open a pass on a future day (issue #3725). Until
that day the pass already running keeps running, so the new one is recorded
as a pending day on the progress row and becomes a ``programpass`` row when it
arrives. Additive and nullable: no account has a pending pass yet.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a4c8e2f6b1d3"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "9d2b6e4f1a73"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the nullable pending-pass day."""
    op.add_column(
        "stageprogress",
        sa.Column("pending_pass_starts_on", sa.Date(), nullable=True),
    )


def downgrade() -> None:
    """Drop the pending-pass day; a pass still pending is forgotten."""
    op.drop_column("stageprogress", "pending_pass_starts_on")
