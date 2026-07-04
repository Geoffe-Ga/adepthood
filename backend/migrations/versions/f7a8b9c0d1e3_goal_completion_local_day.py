"""goal_completion local_day column and local-day unique index

Revision ID: f7a8b9c0d1e3
Revises: e6f7a8b9c0d2
Create Date: 2026-07-04 00:00:00.000000

The check-in service enforces "one completion per goal per user-LOCAL day", but
the previous unique index bucketed on ``((timestamp AT TIME ZONE 'UTC')::date)``
-- one row per UTC calendar day. For a user east of UTC, two completions on
distinct local days that happen to share a UTC date collided; the resulting
``IntegrityError`` was swallowed and a legitimate completion silently dropped.

This migration adds a ``local_day`` column populated by the service to the
user-local target day, backfills it from existing rows, and swaps the UTC-day
functional unique index for a plain ``(goal_id, user_id, local_day)`` index
under the SAME name so the constraint moves to the correct granularity.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f7a8b9c0d1e3"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "e6f7a8b9c0d2"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_UNIQUE_PER_DAY_INDEX = "ix_goal_completion_unique_per_day"
_ARCHIVE_TABLE = "_duplicates_goalcompletion"


def _backfill_local_day() -> None:
    """Populate ``local_day`` from each row's timestamp in the user's timezone.

    On Postgres the conversion honours the owning user's recorded timezone
    (defaulting to UTC) so historical rows land on the same local day the app
    would now write. On SQLite -- the round-trip test target -- the old
    conftest mirror bucketed on ``date(timestamp)``, so we reproduce that here
    to keep the upgrade/downgrade round-trip lossless.
    """
    dialect = op.get_bind().dialect.name
    if dialect == "postgresql":
        op.execute(
            "UPDATE goalcompletion "
            "SET local_day = ((timestamp AT TIME ZONE COALESCE(u.timezone, 'UTC'))::date) "
            'FROM "user" u '
            "WHERE u.id = goalcompletion.user_id"
        )
    else:
        op.execute("UPDATE goalcompletion SET local_day = date(timestamp)")


def _archive_and_drop_local_day_duplicates() -> None:
    """Archive, then delete, rows that duplicate a ``(goal_id, user_id, local_day)`` group.

    Two rows can share a local day only when a boundary race wrote both before
    the tightened constraint existed -- the app already treats them as one
    completion. We keep the lowest ``id`` (first-wins, matching the app's
    idempotency) and move the losers into ``_duplicates_goalcompletion`` so the
    unique index can be created and the discarded rows are archived for audit
    rather than silently dropped.
    """
    op.execute(
        f"CREATE TABLE IF NOT EXISTS {_ARCHIVE_TABLE} AS SELECT * FROM goalcompletion WHERE false"
    )
    op.execute(
        f"INSERT INTO {_ARCHIVE_TABLE} "
        "SELECT * FROM goalcompletion gc "
        "WHERE gc.id NOT IN ("
        "  SELECT min(id) FROM goalcompletion "
        "  GROUP BY goal_id, user_id, local_day"
        ")"
    )
    op.execute(f"DELETE FROM goalcompletion WHERE id IN (SELECT id FROM {_ARCHIVE_TABLE})")


def upgrade() -> None:
    """Add ``local_day``, backfill + dedup, then swap in the local-day unique index."""
    op.add_column("goalcompletion", sa.Column("local_day", sa.Date(), nullable=True))
    _backfill_local_day()
    _archive_and_drop_local_day_duplicates()
    # Drop the old UTC-day index before the batch-mode NOT NULL tightening: on
    # SQLite the batch step recreates the table, and it cannot carry over the
    # old functional (expression) index. Postgres does a plain ALTER, so the
    # drop order is immaterial there.
    op.execute(f'DROP INDEX IF EXISTS "{_UNIQUE_PER_DAY_INDEX}"')
    # Batch mode keeps the NOT NULL tightening SQLite-compatible for the
    # round-trip test while emitting a plain ALTER on the Postgres target.
    with op.batch_alter_table("goalcompletion") as batch_op:
        batch_op.alter_column(
            "local_day",
            existing_type=sa.Date(),
            existing_nullable=True,
            nullable=False,
        )
    op.execute(
        f'CREATE UNIQUE INDEX "{_UNIQUE_PER_DAY_INDEX}" '
        "ON goalcompletion (goal_id, user_id, local_day)"
    )


def downgrade() -> None:
    """Restore the UTC-day unique index and drop ``local_day``.

    Re-tightening to one row per UTC calendar day can legitimately fail on
    post-fix data that holds two local days sharing a UTC date -- that is
    inherent to reverting this fix, not a bug in the downgrade. Rows archived
    into ``_duplicates_goalcompletion`` during upgrade are NOT re-inserted; the
    archive is for audit only.
    """
    op.execute(f'DROP INDEX IF EXISTS "{_UNIQUE_PER_DAY_INDEX}"')
    # Batch mode keeps the column drop SQLite-compatible for the round-trip test.
    with op.batch_alter_table("goalcompletion") as batch_op:
        batch_op.drop_column("local_day")
    if op.get_bind().dialect.name == "postgresql":
        op.execute(
            f'CREATE UNIQUE INDEX "{_UNIQUE_PER_DAY_INDEX}" '
            "ON goalcompletion "
            "(goal_id, user_id, ((timestamp AT TIME ZONE 'UTC')::date))"
        )
    else:
        op.execute(
            f'CREATE UNIQUE INDEX "{_UNIQUE_PER_DAY_INDEX}" '
            "ON goalcompletion (goal_id, user_id, date(timestamp))"
        )
