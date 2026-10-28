"""Add the content-free restore-suppression marker (#3063).

Revision ID: f5539c70e00d
Revises: b05e0a2de1cd
Create Date: 2026-10-07 00:00:00.000000

``restoremarker`` records that a restored database had its exported deletion
tombstones reapplied: an operator-chosen restore id, a closed state
(``in_progress`` / ``complete``), counts, timestamps and the build version. It
names no account and holds no content. Purely additive; ``downgrade`` drops the
table. The state vocabulary is frozen at this revision rather than imported
from ``src``, so this revision means the same thing forever.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f5539c70e00d"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "b05e0a2de1cd"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "restoremarker"

# Widths and vocabulary frozen at this revision (mirrored by models.restore_marker).
_RESTORE_ID_WIDTH = 64
_STATE_WIDTH = 16
_BUILD_VERSION_WIDTH = 64
_STATES = ("in_progress", "complete")


def upgrade() -> None:
    """Create the marker table with its closed state and non-negative counts."""
    states = ", ".join(f"'{state}'" for state in _STATES)
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("restore_id", sa.String(length=_RESTORE_ID_WIDTH), nullable=False),
        sa.Column("state", sa.String(length=_STATE_WIDTH), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("accounts_reapplied", sa.Integer(), nullable=False),
        sa.Column("entries_reapplied", sa.Integer(), nullable=False),
        sa.Column("identity_mismatches", sa.Integer(), nullable=False),
        sa.Column("build_version", sa.String(length=_BUILD_VERSION_WIDTH), nullable=True),
        sa.CheckConstraint(f"state IN ({states})", name="ck_restoremarker_state_valid"),
        sa.CheckConstraint(
            "accounts_reapplied >= 0 AND entries_reapplied >= 0 AND identity_mismatches >= 0",
            name="ck_restoremarker_counts_range",
        ),
        sa.UniqueConstraint("restore_id"),
    )


def downgrade() -> None:
    """Drop the marker table; no other table changes."""
    op.drop_table(_TABLE)
