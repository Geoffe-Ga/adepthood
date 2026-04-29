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

The catalog / audit tables get ``ON DELETE SET NULL`` instead so
historical context survives the deletion of its creator or actor:

  * ``goalgroup.user_id`` -- shared template groups outlive any
    individual creator.
  * ``practice.submitted_by_user_id`` -- catalog practices stay in
    the library; the attribution becomes anonymous.
  * ``walletaudit.actor_user_id`` -- financial-audit history must
    outlive the deletion of an admin who acted on someone else's
    wallet; ``user_id`` (the wallet owner) still cascades because
    the audit row is meaningless without that anchor.

Drops and re-creates each user FK with the Postgres default name
(``<table>_<column>_fkey``) so the constraint name on disk matches
what Alembic's autogenerate produces from the model metadata --
otherwise ``alembic check`` would diff every FK as a "remove + add"
pair and the migration-drift CI would fail.

Tests run against SQLite via ``metadata.create_all`` and do not
execute this migration; production / CI use Postgres so the
drop-then-create pattern is portable for the targets that matter.
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
    ("walletaudit", "actor_user_id", "SET NULL"),
)


def _fk_name(table: str, column: str) -> str:
    """Postgres' default name for an auto-named FK on ``<table>.<column>``."""
    return f"{table}_{column}_fkey"


def upgrade() -> None:
    """Replace each user FK with one that carries the appropriate ondelete."""
    # ``walletaudit.actor_user_id`` must be nullable for ``SET NULL`` to have
    # a target.  The column landed as ``NOT NULL`` in the wallet-audit
    # migration; relax it before swapping the FK so a future actor-user
    # deletion can null the row without violating the column constraint.
    op.alter_column("walletaudit", "actor_user_id", existing_type=sa.Integer(), nullable=True)
    for table, column, on_delete in _USER_FK_TABLES:
        name = _fk_name(table, column)
        op.drop_constraint(name, table, type_="foreignkey")
        op.create_foreign_key(
            name,
            table,
            "user",
            [column],
            ["id"],
            ondelete=on_delete,
        )


def downgrade() -> None:
    """Restore each user FK without an ondelete clause."""
    for table, column, _ in reversed(_USER_FK_TABLES):
        name = _fk_name(table, column)
        op.drop_constraint(name, table, type_="foreignkey")
        op.create_foreign_key(name, table, "user", [column], ["id"])
    op.alter_column("walletaudit", "actor_user_id", existing_type=sa.Integer(), nullable=False)
