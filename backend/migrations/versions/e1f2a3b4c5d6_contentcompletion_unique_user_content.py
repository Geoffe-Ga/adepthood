"""contentcompletion unique (user_id, content_id)

Revision ID: e1f2a3b4c5d6
Revises: d1e2f3a4b5c6
Create Date: 2026-04-28 00:00:00.000000

BUG-COURSE-002: ``mark_content_read`` did a SELECT-then-INSERT to enforce
"read once per content."  Two concurrent mark-read requests could both
pass the existence check before either committed and both write a row,
inflating progress percentages and breaking the user-visible "read"
toggle's invariant with the row count.

This migration deduplicates legacy rows (keeping the earliest
``id``-wise per ``(user_id, content_id)`` group) and adds a unique
constraint at the database level so the application can safely drop
the pre-check and rely on ``IntegrityError → idempotent response``.
The duplicates are archived to ``_duplicates_contentcompletion`` for
audit; the archive table is created in the database's default schema
and is not exposed through any router or RLS policy, satisfying the
prompt's "dedup archive must not be user-readable" requirement.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e1f2a3b4c5d6"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "d1e2f3a4b5c6"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_UNIQUE_CONSTRAINT = "uq_contentcompletion_user_content"


def upgrade() -> None:
    """Archive legacy duplicates, then add the unique constraint."""
    # 1. Archive duplicates so the constraint creation cannot fail on
    #    pre-existing data.  Keeps the earliest (lowest-id) row per
    #    (user_id, content_id) pair on the assumption that the first
    #    "mark read" is the canonical one.
    op.execute(
        "CREATE TABLE IF NOT EXISTS _duplicates_contentcompletion "
        "AS SELECT * FROM contentcompletion WHERE false"
    )
    op.execute(
        "INSERT INTO _duplicates_contentcompletion "
        "SELECT * FROM contentcompletion cc "
        "WHERE cc.id NOT IN ("
        "  SELECT min(id) FROM contentcompletion "
        "  GROUP BY user_id, content_id"
        ")"
    )
    op.execute(
        "DELETE FROM contentcompletion "
        "WHERE id IN (SELECT id FROM _duplicates_contentcompletion)"
    )

    # 2. Add the constraint.  Using ``create_unique_constraint`` (rather
    #    than a functional index) keeps the constraint discoverable via
    #    ``information_schema.table_constraints`` and aligns with the
    #    SQLModel ``__table_args__`` declaration on
    #    :class:`models.ContentCompletion` so ``alembic check`` does not
    #    flag drift after this lands.
    op.create_unique_constraint(
        _UNIQUE_CONSTRAINT,
        "contentcompletion",
        ["user_id", "content_id"],
    )


def downgrade() -> None:
    """Drop the unique constraint.

    The archived duplicates are intentionally **not** re-inserted: the
    archive is for audit only, and re-inserting would re-introduce the
    very inconsistency the upgrade resolved.
    """
    op.drop_constraint(_UNIQUE_CONSTRAINT, "contentcompletion", type_="unique")
