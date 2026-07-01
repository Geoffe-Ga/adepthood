"""add invitation_signal table for detected deeper-ring invitations.

Revision ID: b3c4d5e6f7a8
Revises: f2a3b4c5d6e8
Create Date: 2026-07-01 00:00:00.000000

Purely additive: ``upgrade`` creates the ``invitationsignal`` table (a detected,
declinable invitation to descend into a self-chosen ring) with its owner FK
(cascading), the two enum CHECK constraints, the two partial unique indexes that
enforce one live-or-dismissed invitation per coordinate (splitting on whether
``target_id`` is set), and the non-unique owner index. ``downgrade`` drops the
indexes then the table. No ``ALTER`` / ``DROP`` against existing tables.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b3c4d5e6f7a8"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "f2a3b4c5d6e8"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TARGET_TYPE_CHECK = (
    "target_type IN ('habit', 'practice', 'course', 'sangha', 'embodied_community')"
)
_KIND_CHECK = "kind IN ('readiness', 'consistency', 'mastery')"


def upgrade() -> None:
    """Create the ``invitationsignal`` table, its CHECKs, and its indexes."""
    op.create_table(
        "invitationsignal",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("target_type", sa.String(length=32), nullable=False),
        sa.Column("target_id", sa.Integer(), nullable=True),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("dismissed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            _TARGET_TYPE_CHECK,
            name="ck_invitation_signal_target_type_valid",
        ),
        sa.CheckConstraint(
            _KIND_CHECK,
            name="ck_invitation_signal_kind_valid",
        ),
    )
    # Two partial unique indexes split on whether ``target_id`` is set: the
    # NULL branch is needed because SQL treats two NULLs as distinct in an
    # ordinary UNIQUE. Both spans cover dismissed rows too, so a declined
    # invitation is never silently recreated.
    op.create_index(
        "ix_invitation_signal_user_target",
        "invitationsignal",
        ["user_id", "target_type", "target_id", "kind"],
        unique=True,
        postgresql_where=sa.text("target_id IS NOT NULL"),
        sqlite_where=sa.text("target_id IS NOT NULL"),
    )
    op.create_index(
        "ix_invitation_signal_user_target_null",
        "invitationsignal",
        ["user_id", "target_type", "kind"],
        unique=True,
        postgresql_where=sa.text("target_id IS NULL"),
        sqlite_where=sa.text("target_id IS NULL"),
    )
    op.create_index(
        "ix_invitation_signal_user_id",
        "invitationsignal",
        ["user_id"],
    )


def downgrade() -> None:
    """Drop the ``invitationsignal`` indexes then the table."""
    op.drop_index("ix_invitation_signal_user_id", table_name="invitationsignal")
    op.drop_index("ix_invitation_signal_user_target_null", table_name="invitationsignal")
    op.drop_index("ix_invitation_signal_user_target", table_name="invitationsignal")
    op.drop_table("invitationsignal")
