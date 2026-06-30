"""index completion_suggestion target FKs (goal_id, user_practice_id).

Revision ID: c5d6e7f8a9b0
Revises: a3b4c5d6e7f9
Create Date: 2026-06-30 00:00:00.000000

Purely additive: ``upgrade`` creates B-tree indexes on the polymorphic target
FK columns ``goal_id`` and ``user_practice_id`` so reverse lookups ("pending
suggestions for goal X" / "for user-practice Y") are range scans rather than
full table scans (Postgres does not auto-index FK columns). ``downgrade`` drops
them. No ``ALTER`` / ``DROP`` against existing columns or data.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c5d6e7f8a9b0"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "a3b4c5d6e7f9"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create FK indexes on ``goal_id`` and ``user_practice_id``."""
    op.create_index(
        "ix_completion_suggestion_goal_id",
        "completionsuggestion",
        ["goal_id"],
    )
    op.create_index(
        "ix_completion_suggestion_user_practice_id",
        "completionsuggestion",
        ["user_practice_id"],
    )


def downgrade() -> None:
    """Drop the FK indexes on ``goal_id`` and ``user_practice_id``."""
    op.drop_index(
        "ix_completion_suggestion_user_practice_id",
        table_name="completionsuggestion",
    )
    op.drop_index(
        "ix_completion_suggestion_goal_id",
        table_name="completionsuggestion",
    )
