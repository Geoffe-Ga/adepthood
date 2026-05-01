"""habit unique (user_id, lower(trim(name))) index

Revision ID: b5c6d7e8f9a0
Revises: a4b5c6d7e8f9
Create Date: 2026-05-01 00:00:00.000000

Closes the duplicate-habit-name TOCTOU.  The application gate in
``create_habit`` does a SELECT-then-INSERT to reject case-only / whitespace
duplicates, but two concurrent requests could both pass the SELECT before
either committed.  A functional unique index on ``(user_id, lower(trim(name)))``
makes the invariant a database-level guarantee so the router can rely on
``IntegrityError -> 409 duplicate_habit_name`` for the race-loser path.

Pre-existing case / whitespace duplicates are deduplicated before the
index is created: child rows (goals + their completions) reattach to the
keeper (lowest-id row per ``(user_id, normalized_name)`` group) so the
constraint creation cannot fail on legacy data.  Hard duplicates are
dropped; the cascading FKs handle the orphaned children automatically.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b5c6d7e8f9a0"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "a4b5c6d7e8f9"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_UNIQUE_INDEX = "ix_habit_user_lower_name_unique"


def upgrade() -> None:
    """Reattach legacy duplicates' children, drop duplicates, then add the index."""
    # 1. Reassign goals (and their completions cascade automatically on the
    #    FK) from duplicate habits to the keeper -- the lowest id row per
    #    (user_id, lower(trim(name))) group.
    op.execute(
        """
        WITH dupes AS (
            SELECT h.id AS dupe_id, keeper.keeper_id
            FROM habit h
            JOIN (
                SELECT user_id, lower(trim(name)) AS norm_name, min(id) AS keeper_id
                FROM habit
                GROUP BY user_id, lower(trim(name))
                HAVING count(*) > 1
            ) keeper
              ON keeper.user_id = h.user_id
             AND keeper.norm_name = lower(trim(h.name))
             AND h.id != keeper.keeper_id
        )
        UPDATE goal SET habit_id = dupes.keeper_id
        FROM dupes
        WHERE goal.habit_id = dupes.dupe_id
        """
    )

    # 2. Delete the duplicate habit rows (their goals already moved).
    op.execute(
        """
        DELETE FROM habit
        WHERE id IN (
            SELECT h.id FROM habit h
            JOIN (
                SELECT user_id, lower(trim(name)) AS norm_name, min(id) AS keeper_id
                FROM habit
                GROUP BY user_id, lower(trim(name))
                HAVING count(*) > 1
            ) keeper
              ON keeper.user_id = h.user_id
             AND keeper.norm_name = lower(trim(h.name))
             AND h.id != keeper.keeper_id
        )
        """
    )

    # 3. Add the case- and whitespace-insensitive unique index.
    op.execute(
        f'CREATE UNIQUE INDEX "{_UNIQUE_INDEX}" '
        "ON habit (user_id, lower(trim(name)))"
    )


def downgrade() -> None:
    """Drop the unique index; row deduplication is not reversed."""
    op.execute(f'DROP INDEX IF EXISTS "{_UNIQUE_INDEX}"')
