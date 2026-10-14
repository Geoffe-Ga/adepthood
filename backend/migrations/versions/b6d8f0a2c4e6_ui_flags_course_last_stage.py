"""Remember the highest marked-read course Frequency (#3146)."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b6d8f0a2c4e6"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "b3d5f7a9c1e2"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Existing readers begin without a saved reading position."""
    op.add_column("useruiflags", sa.Column("course_last_stage", sa.Integer(), nullable=True))


def downgrade() -> None:
    """Remove only the reading-position flag."""
    op.drop_column("useruiflags", "course_last_stage")
