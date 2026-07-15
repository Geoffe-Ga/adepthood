"""coursestage/stagecontent dedupe + unique indexes (seeder-race TOCTOU)

Revision ID: b4c5d6e7f8a1
Revises: a9b0c1d2e3f4
Create Date: 2026-07-12 00:00:00.000000

Closes the duplicate-course-row TOCTOU. The production image boots uvicorn
with ``--workers 2`` (backend/Dockerfile CMD), so two workers run the
startup seeders concurrently on every deploy. ``seed_stages`` does a
SELECT-then-INSERT existence check; against a fresh database both workers'
SELECTs see an empty table and both insert, and with no unique index on
``coursestage.stage_number`` every stage row lands twice. ``seed_content``
then maps each stage_number onto only ONE of the duplicate ids (its stage
map keeps the last row it reads), so the other id owns zero content — and
the course endpoints resolve stages with an unordered ``.first()``, routing
users to the content-less duplicate. Symptom: the Course screen shows
"No Content Yet" / "0 of 0 read" for every stage while every request
returns 200 and no error is ever logged.

Same TOCTOU family as ``d2e3f4a5b6c7`` (duplicate practice presets); this
migration applies the identical repoint → delete → unique-index treatment
to the course tables:

1. Repoints ``StageContent.course_stage_id`` from duplicate ``CourseStage``
   rows onto the lowest-id row per ``stage_number``, then deletes the
   duplicate stage rows.
2. Dedupes ``StageContent`` rows sharing a ``content://`` reference within
   one stage: ``ContentCompletion`` read-marks are first collapsed (a user
   who read two copies keeps one mark) and repointed onto the lowest-id
   content row, then the duplicate content rows are deleted.
3. Adds the two unique indexes so a future race-insert fails at the DB
   layer, where ``commit_or_yield_to_race_winner`` turns the loser's
   ``IntegrityError`` into a no-op.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b4c5d6e7f8a1"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "a9b0c1d2e3f4"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_STAGE_UNIQUE_INDEX = "ix_coursestage_stage_number_unique"
_CONTENT_UNIQUE_INDEX = "ix_stagecontent_stage_content_ref_unique"

#: Duplicate CourseStage rows: every row whose id is not the lowest for its
#: ``stage_number``. Reused by the repoint and the delete so the two stay in
#: lock-step.
_DUPLICATE_STAGES = """
    SELECT cs.id AS dupe_id, keeper.keeper_id
    FROM coursestage cs
    JOIN (
        SELECT stage_number, min(id) AS keeper_id
        FROM coursestage
        GROUP BY stage_number
        HAVING count(*) > 1
    ) keeper
      ON keeper.stage_number = cs.stage_number
     AND cs.id != keeper.keeper_id
"""

#: Duplicate StageContent rows: every ``content://`` row whose id is not the
#: lowest for its ``(course_stage_id, url)`` group. Scoped to the
#: ``content://`` scheme — legacy rows with empty or CMS urls may share a
#: url without being copies of one chapter, so they are left alone.
_DUPLICATE_CONTENT = """
    SELECT sc.id AS dupe_id, keeper.keeper_id
    FROM stagecontent sc
    JOIN (
        SELECT course_stage_id, url, min(id) AS keeper_id
        FROM stagecontent
        WHERE url LIKE 'content://%'
        GROUP BY course_stage_id, url
        HAVING count(*) > 1
    ) keeper
      ON keeper.course_stage_id = sc.course_stage_id
     AND keeper.url = sc.url
     AND sc.id != keeper.keeper_id
"""


def upgrade() -> None:
    """Repoint FKs onto keeper rows, drop the dupes, install the indexes."""
    # 1a. Move every StageContent row off the duplicate CourseStage rows so
    #     deleting the dupes can't orphan content (or fail on the FK).
    op.execute(
        f"""
        UPDATE stagecontent SET course_stage_id = dupes.keeper_id
        FROM ({_DUPLICATE_STAGES}) dupes
        WHERE stagecontent.course_stage_id = dupes.dupe_id
        """
    )

    # 1b. Delete the duplicate stage rows now that nothing references them.
    op.execute(f"DELETE FROM coursestage WHERE id IN (SELECT dupe_id FROM ({_DUPLICATE_STAGES}) d)")

    # 2a. A user who read more than one copy of a chapter would collide with
    #     the ``uq_contentcompletion_user_content`` constraint when the dupe
    #     marks are repointed onto the keeper. Collapse first: map every mark
    #     to its canonical (keeper) content id and keep only the lowest-id
    #     mark per (user, canonical content) group. Handles any duplicate
    #     multiplicity (``WEB_CONCURRENCY`` may exceed 2).
    op.execute(
        f"""
        WITH canon AS (
            SELECT cc.id AS cc_id,
                   cc.user_id AS user_id,
                   COALESCE(dupes.keeper_id, cc.content_id) AS canon_content_id
            FROM contentcompletion cc
            LEFT JOIN ({_DUPLICATE_CONTENT}) dupes ON dupes.dupe_id = cc.content_id
        )
        DELETE FROM contentcompletion
        WHERE id IN (
            SELECT c1.cc_id FROM canon c1
            WHERE c1.cc_id != (
                SELECT min(c2.cc_id) FROM canon c2
                WHERE c2.user_id = c1.user_id
                  AND c2.canon_content_id = c1.canon_content_id
            )
        )
        """
    )

    # 2b. Repoint the remaining read-marks onto the keeper content row.
    op.execute(
        f"""
        UPDATE contentcompletion SET content_id = dupes.keeper_id
        FROM ({_DUPLICATE_CONTENT}) dupes
        WHERE contentcompletion.content_id = dupes.dupe_id
        """
    )

    # 2c. Delete the duplicate content rows now that no read-mark references them.
    op.execute(f"DELETE FROM stagecontent WHERE id IN (SELECT dupe_id FROM ({_DUPLICATE_CONTENT}) d)")

    # 3. Lock the door: future race-inserts fail at the DB layer.
    op.execute(f'CREATE UNIQUE INDEX "{_STAGE_UNIQUE_INDEX}" ON coursestage (stage_number)')
    op.execute(
        f'CREATE UNIQUE INDEX "{_CONTENT_UNIQUE_INDEX}" '
        "ON stagecontent (course_stage_id, url) "
        "WHERE url LIKE 'content://%'"
    )


def downgrade() -> None:
    """Drop the unique indexes; row deduplication is not reversed."""
    op.execute(f'DROP INDEX IF EXISTS "{_CONTENT_UNIQUE_INDEX}"')
    op.execute(f'DROP INDEX IF EXISTS "{_STAGE_UNIQUE_INDEX}"')
