"""unique lower(email) index

Revision ID: e8376b41c6a1
Revises: 78b1620cafde
Create Date: 2026-04-15 00:00:00.000000

Guards against case-only duplicate signups (BUG-AUTH-003). The application
now normalizes emails to ``strip().lower()`` at the request boundary, but a
case-sensitive unique constraint would still permit pre-existing duplicates
to coexist. A functional unique index on ``lower(email)`` makes the
invariant a database-level guarantee, not just an application convention.

If the database already contains case-variant duplicates (e.g.
``Geoff@example.com`` and ``geoff@example.com``), this migration merges
them: child records are reassigned to the lowest-id account and the
duplicate rows are deleted before the index is created.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e8376b41c6a1"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "78b1620cafde"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_UNIQUE_LOWER_EMAIL_INDEX = "ix_user_lower_email_unique"

# CTE that pairs each duplicate user row with the keeper (lowest id per email).
_DUPES_CTE = """
    WITH dupes AS (
        SELECT u.id AS dupe_id, keeper.keeper_id
        FROM "user" u
        JOIN (
            SELECT email, min(id) AS keeper_id
            FROM "user"
            GROUP BY email
            HAVING count(*) > 1
        ) keeper ON keeper.email = u.email AND u.id != keeper.keeper_id
    )
"""

# Child tables whose user_id FK should be reassigned to the keeper.
_CHILD_TABLES: list[tuple[str, str]] = [
    ("habit", "user_id"),
    ("promptresponse", "user_id"),
    ("contentcompletion", "user_id"),
    ("userpractice", "user_id"),
    ("goalcompletion", "user_id"),
    ("practicesession", "user_id"),
    ("journalentry", "user_id"),
    ("llmusagelog", "user_id"),
    ("goalgroup", "user_id"),
    ("practice", "submitted_by_user_id"),
]


def upgrade() -> None:
    """Deduplicate case-variant emails, then add a unique index on lower(email)."""
    # 1. Normalize every email to lowercase.
    op.execute('UPDATE "user" SET email = lower(email)')

    # 2. Reassign child records from duplicate users to the keeper.
    for table, col in _CHILD_TABLES:
        op.execute(
            f"{_DUPES_CTE}"
            f'UPDATE "{table}" SET {col} = dupes.keeper_id '
            f'FROM dupes WHERE "{table}".{col} = dupes.dupe_id'
        )

    # 3. stageprogress has a UNIQUE(user_id) constraint — special handling.
    #    Delete the duplicate's row when the keeper already has one.
    op.execute(
        f"{_DUPES_CTE}"
        "DELETE FROM stageprogress USING dupes "
        "WHERE stageprogress.user_id = dupes.dupe_id "
        "AND EXISTS ("
        "  SELECT 1 FROM stageprogress sp2 WHERE sp2.user_id = dupes.keeper_id"
        ")"
    )
    #    Reassign any remaining (keeper had no stageprogress).
    op.execute(
        f"{_DUPES_CTE}"
        "UPDATE stageprogress SET user_id = dupes.keeper_id "
        "FROM dupes WHERE stageprogress.user_id = dupes.dupe_id"
    )

    # 4. Delete duplicate user rows (all children have been moved).
    op.execute(
        'DELETE FROM "user" '
        "WHERE id NOT IN (SELECT min(id) FROM \"user\" GROUP BY email)"
    )

    # 5. Create the case-insensitive unique index.
    op.execute(
        f'CREATE UNIQUE INDEX "{_UNIQUE_LOWER_EMAIL_INDEX}" '
        'ON "user" (lower(email))'
    )


def downgrade() -> None:
    """Drop the case-insensitive unique index.

    Note: row deduplication performed during upgrade is not reversed.
    """
    op.execute(f'DROP INDEX IF EXISTS "{_UNIQUE_LOWER_EMAIL_INDEX}"')
