"""add completion_suggestion table for journal-attested completions.

Revision ID: a3b4c5d6e7f9
Revises: f1e2d3c4b5a6
Create Date: 2026-06-30 00:00:00.000000

Purely additive: ``upgrade`` creates the ``completionsuggestion`` table (a
resonance-pass proposal that a journal span attests to completing a habit goal
or a user-practice) plus its FK indexes; ``downgrade`` drops them. No ``ALTER`` /
``DROP`` against existing tables. The FKs cascade so deleting the journal entry,
owner, goal, or user-practice removes the suggestion.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a3b4c5d6e7f9"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "f1e2d3c4b5a6"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the ``completionsuggestion`` table and its FK indexes."""
    op.create_table(
        "completionsuggestion",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("journal_entry_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("target_type", sa.String(length=20), nullable=False),
        sa.Column("goal_id", sa.Integer(), nullable=True),
        sa.Column("user_practice_id", sa.Integer(), nullable=True),
        sa.Column("label", sa.String(length=255), nullable=False),
        sa.Column("anchor_start", sa.Integer(), nullable=False),
        sa.Column("anchor_end", sa.Integer(), nullable=False),
        sa.Column("anchor_text", sa.String(length=280), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["journal_entry_id"], ["journalentry.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["goal_id"], ["goal.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_practice_id"], ["userpractice.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "target_type IN ('habit', 'practice')",
            name="ck_completion_suggestion_target_type_valid",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'accepted', 'dismissed')",
            name="ck_completion_suggestion_status_valid",
        ),
        sa.CheckConstraint(
            "anchor_start >= 0",
            name="ck_completion_suggestion_anchor_start_nonneg",
        ),
        sa.CheckConstraint(
            "anchor_end > anchor_start",
            name="ck_completion_suggestion_anchor_span_positive",
        ),
        sa.CheckConstraint(
            "(target_type = 'habit' AND goal_id IS NOT NULL AND user_practice_id IS NULL)"
            " OR (target_type = 'practice' AND user_practice_id IS NOT NULL AND goal_id IS NULL)",
            name="ck_completion_suggestion_target_fk_matches",
        ),
    )
    op.create_index(
        "ix_completion_suggestion_journal_entry_id",
        "completionsuggestion",
        ["journal_entry_id"],
    )
    op.create_index(
        "ix_completion_suggestion_user_id",
        "completionsuggestion",
        ["user_id"],
    )


def downgrade() -> None:
    """Drop the ``completionsuggestion`` table and its indexes."""
    op.drop_index("ix_completion_suggestion_user_id", table_name="completionsuggestion")
    op.drop_index("ix_completion_suggestion_journal_entry_id", table_name="completionsuggestion")
    op.drop_table("completionsuggestion")
