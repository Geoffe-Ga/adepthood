"""add practicesessionspend table for DB-backed practice-session idempotency.

Revision ID: d0e1f2a3b4c5
Revises: c8d9e0f1a2b3
Create Date: 2026-06-26 00:00:00.000000

Practice-session idempotency lived in a per-process dict: it died on restart and
did not hold across workers, so two requests with the same Idempotency-Key on
different workers could both insert a PracticeSession. This table makes the dedup
durable and cross-worker — the UNIQUE(user_id, idem_key) constraint serialises the
check-then-insert race at the database. Purely additive: ``upgrade`` creates the
table + its indexes; ``downgrade`` drops them.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d0e1f2a3b4c5"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "c8d9e0f1a2b3"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the ``practicesessionspend`` table and its indexes."""
    op.create_table(
        "practicesessionspend",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("idem_key", sa.String(length=128), nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["session_id"], ["practicesession.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "idem_key", name="uq_practicesessionspend_user_idem_key"),
    )
    op.create_index("ix_practicesessionspend_user_id", "practicesessionspend", ["user_id"])
    op.create_index("ix_practicesessionspend_idem_key", "practicesessionspend", ["idem_key"])


def downgrade() -> None:
    """Drop the ``practicesessionspend`` table and its indexes."""
    op.drop_index("ix_practicesessionspend_idem_key", table_name="practicesessionspend")
    op.drop_index("ix_practicesessionspend_user_id", table_name="practicesessionspend")
    op.drop_table("practicesessionspend")
