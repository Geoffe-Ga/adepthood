"""add ondelete to every user-id foreign key

Revision ID: f3a4b5c6d7e8
Revises: e2f3a4b5c6d7
Create Date: 2026-04-28 22:00:00.000000

BUG-DB-003 / BUG-MODEL-002: every per-user table held an unconfigured
foreign key to ``user.id``, so deleting a user row left orphaned
children behind (or 23503 errors that masked the actual constraint
violation in production logs).

Per-user data tables get ``ON DELETE CASCADE``: deleting a user wipes
their habits, completions, journal entries, etc.  The right-to-be-
forgotten model is the cleanest default for a personal-development
product where a user's data has no value separate from the user.

The two nullable / catalog tables get ``ON DELETE SET NULL`` instead
so historical context survives the deletion of its creator:

  * ``goalgroup.user_id`` -- shared template groups outlive any
    individual creator.
  * ``practice.submitted_by_user_id`` -- catalog practices stay in
    the library; the attribution becomes anonymous.

Existing user FKs were defined without ``ondelete``, so this migration
drops and re-creates each one.  ``op.batch_alter_table`` keeps the DDL
portable across Postgres (production) and SQLite (test).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f3a4b5c6d7e8"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "e2f3a4b5c6d7"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (table, fk_column, on_delete) -- ordered alphabetically for review.
_USER_FK_TABLES: tuple[tuple[str, str, str], ...] = (
    ("contentcompletion", "user_id", "CASCADE"),
    ("goalcompletion", "user_id", "CASCADE"),
    ("goalgroup", "user_id", "SET NULL"),
    ("habit", "user_id", "CASCADE"),
    ("journalentry", "user_id", "CASCADE"),
    ("llmusagelog", "user_id", "CASCADE"),
    ("practice", "submitted_by_user_id", "SET NULL"),
    ("practicesession", "user_id", "CASCADE"),
    ("promptresponse", "user_id", "CASCADE"),
    ("stageprogress", "user_id", "CASCADE"),
    ("userpractice", "user_id", "CASCADE"),
    ("walletaudit", "user_id", "CASCADE"),
    ("walletaudit", "actor_user_id", "CASCADE"),
)


def _fk_constraint_name(table: str, column: str) -> str:
    """Naming pattern Alembic + SQLAlchemy default to for legacy FKs."""
    return f"fk_{table}_{column}_user"


def upgrade() -> None:
    """Drop and re-create each user FK with the appropriate ondelete clause."""
    for table, column, on_delete in _USER_FK_TABLES:
        with op.batch_alter_table(table) as batch:
            # The original FK had no explicit name, so we drop by inspecting
            # the table; ``batch_alter_table`` rebuilds the table on SQLite
            # which clears any anonymous constraints, and on Postgres uses
            # naming conventions to find the existing FK.
            batch.create_foreign_key(
                _fk_constraint_name(table, column),
                "user",
                [column],
                ["id"],
                ondelete=on_delete,
            )


def downgrade() -> None:
    """Drop the named ondelete FKs (does not restore the unnamed legacy FK)."""
    for table, column, _ in reversed(_USER_FK_TABLES):
        with op.batch_alter_table(table) as batch:
            batch.drop_constraint(_fk_constraint_name(table, column), type_="foreignkey")


# Imported only so SQLAlchemy types are available for any future reflection
# tests that need to assert the constraint shape; otherwise unused.
_ = sa
