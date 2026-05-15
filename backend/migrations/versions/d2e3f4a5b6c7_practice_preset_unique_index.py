"""practice partial unique index on (stage_number, lower(trim(name))) for presets

Revision ID: d2e3f4a5b6c7
Revises: c5ed9dd1dabc
Create Date: 2026-05-15 23:00:00.000000

Closes the duplicate-preset-practice TOCTOU. ``seed_practices`` does a
SELECT-then-INSERT match on ``(stage_number, name)`` for rows where
``submitted_by_user_id IS NULL`` to stay idempotent, but two concurrent
boots — for example, a rolling-restart deploy where two workers run
``lifespan`` in parallel — can both pass the SELECT before either
commits and insert a second copy of every preset. Symptom: every stage
shows two "5-4-3-2-1 grounding", two "Tarot meditation", and so on.

This migration:

1. Repoints any ``UserPractice.practice_id`` references from the
   duplicate rows back to the lowest-id row per
   ``(stage_number, lower(trim(name)))`` group, so deleting the dupes
   doesn't orphan any user selections.
2. Deletes the duplicate ``Practice`` rows (only for presets — the
   ``submitted_by_user_id IS NULL`` filter is what keeps user-submitted
   practices with the same name alone).
3. Adds a partial functional unique index so future race-inserts fail
   at the DB layer.

Modelled on PR #287's ``b5c6d7e8f9a0_habit_unique_user_lower_name``.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d2e3f4a5b6c7"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "c5ed9dd1dabc"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_UNIQUE_INDEX = "ix_practice_preset_stage_lower_name_unique"


def upgrade() -> None:
    """Repoint UserPractice FKs onto the keeper row, drop dupes, add the index."""
    # 1. Reassign UserPractice.practice_id from duplicate Practice rows to
    #    the keeper (lowest-id row per (stage_number, lower(trim(name)))
    #    group). Without this the DELETE below would either fail on the FK
    #    constraint or orphan a UserPractice row.
    op.execute(
        """
        WITH dupes AS (
            SELECT p.id AS dupe_id, keeper.keeper_id
            FROM practice p
            JOIN (
                SELECT stage_number, lower(trim(name)) AS norm_name, min(id) AS keeper_id
                FROM practice
                WHERE submitted_by_user_id IS NULL
                GROUP BY stage_number, lower(trim(name))
                HAVING count(*) > 1
            ) keeper
              ON keeper.stage_number = p.stage_number
             AND keeper.norm_name = lower(trim(p.name))
             AND p.id != keeper.keeper_id
            WHERE p.submitted_by_user_id IS NULL
        )
        UPDATE userpractice SET practice_id = dupes.keeper_id
        FROM dupes
        WHERE userpractice.practice_id = dupes.dupe_id
        """
    )

    # 2. Delete the duplicate preset rows now that no FK references them.
    op.execute(
        """
        DELETE FROM practice
        WHERE id IN (
            SELECT p.id FROM practice p
            JOIN (
                SELECT stage_number, lower(trim(name)) AS norm_name, min(id) AS keeper_id
                FROM practice
                WHERE submitted_by_user_id IS NULL
                GROUP BY stage_number, lower(trim(name))
                HAVING count(*) > 1
            ) keeper
              ON keeper.stage_number = p.stage_number
             AND keeper.norm_name = lower(trim(p.name))
             AND p.id != keeper.keeper_id
            WHERE p.submitted_by_user_id IS NULL
        )
        """
    )

    # 3. Add the partial functional unique index. ``WHERE submitted_by_user_id
    #    IS NULL`` scopes it to presets — user-submitted practices remain
    #    free to share a name with a preset or with each other.
    op.execute(
        f'CREATE UNIQUE INDEX "{_UNIQUE_INDEX}" '
        "ON practice (stage_number, lower(trim(name))) "
        "WHERE submitted_by_user_id IS NULL"
    )


def downgrade() -> None:
    """Drop the unique index; row deduplication is not reversed."""
    op.execute(f'DROP INDEX IF EXISTS "{_UNIQUE_INDEX}"')
