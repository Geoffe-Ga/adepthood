"""Add habit.auto_revealed_at, the one-shot marker behind the calendar reveal.

Revision ID: de6c2ca1ab1b
Revises: e9a4c6d8f0b2
Create Date: 2026-09-07 00:00:00.000000

Issue #2576: the owner's ruling of 2026-09-06 reversed #1332 / PR #1349's
"nothing auto-unlocks". The program calendar now reveals each program habit
**once**, on the first ``GET /habits/`` after the habit's slot opens, and the
server stamps that moment here. ``NULL`` means the calendar has never revealed
the row; a non-null value means it already has, so a later manual relock is
final — the reveal never repeats. Every existing habit is therefore ``NULL``:
nothing that shipped before this column can have been auto-revealed, and a
nullable column needs no server default to say so. ``downgrade`` drops the
column inside ``batch_alter_table`` so the SQLite round-trip test stays
compatible with the Postgres prod target.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "de6c2ca1ab1b"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "e9a4c6d8f0b2"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the nullable, timezone-aware ``auto_revealed_at`` stamp."""
    op.add_column(
        "habit",
        sa.Column("auto_revealed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    """Drop the auto_revealed_at column."""
    # Batch mode keeps the downgrade SQLite-compatible.
    with op.batch_alter_table("habit") as batch_op:
        batch_op.drop_column("auto_revealed_at")
