"""add passwordresettoken.lookup_key

Revision ID: d7e8f9a0b1c2
Revises: c6d7e8f9a0b1
Create Date: 2026-05-03 17:00:00.000000

PR #287 round-4 review: ``_select_active_token_only`` was scanning
the entire ``passwordresettoken`` table on every confirm / cancel,
running a 50 ms bcrypt verify on each row.  Above modest user counts
that becomes a DoS amplifier -- the scan grows with
``concurrent_active_tokens`` (= ``users * TTL_minutes / 30``), not
with the request rate.

The fix adds a non-secret lookup column populated at mint time with
``sha256(plaintext_token)[:16]``.  Confirm / cancel queries pre-filter
on this column (which is indexed), so the bcrypt verify only runs on
the at-most-handful of rows that share the 64-bit prefix -- in
practice always exactly one row.  bcrypt is still the security gate;
the lookup_key is a non-secret hash.

Backfill: existing rows (if any -- the prior migration just landed)
get a deterministic recomputation isn't possible without the raw
plaintext, so we leave them inert by setting an empty string.  Their
TTL is 30 minutes and they will expire / be cancelled out organically;
the lookup_key index simply won't help find them.  The cleanup job
prunes them in 7 days.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d7e8f9a0b1c2"  # pragma: allowlist secret
down_revision: Union[str, Sequence[str], None] = "c6d7e8f9a0b1"  # pragma: allowlist secret
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add ``lookup_key`` column + index on ``passwordresettoken``.

    Wrapped in ``batch_alter_table`` so the ``alter_column`` to drop
    the server_default works on SQLite (which lacks ``ALTER COLUMN``
    DDL natively) as well as PostgreSQL.  The batch path on Postgres
    produces the same single ALTER TABLE; on SQLite Alembic copies
    the table, applies changes, then renames -- transparently.
    This is what makes the round-trip migration test pass on SQLite
    in CI without changing prod behavior.
    """
    # NOT NULL with a server-side empty-string default so existing rows
    # are migrated cleanly; new rows always supply the real key from
    # the application layer.  The default is dropped after the column
    # is in place -- the model declares it ``nullable=False`` without a
    # default so any future writer that forgets the key fails loudly.
    with op.batch_alter_table("passwordresettoken") as batch_op:
        batch_op.add_column(
            sa.Column("lookup_key", sa.String(length=32), nullable=False, server_default=""),
        )
        batch_op.alter_column("lookup_key", server_default=None)
    op.create_index(
        "ix_passwordresettoken_lookup_key",
        "passwordresettoken",
        ["lookup_key"],
    )


def downgrade() -> None:
    """Drop the ``lookup_key`` column and its index.

    ``batch_alter_table`` keeps the column drop SQLite-compatible too
    (SQLite < 3.35 lacked ``DROP COLUMN``; the batch path always
    works regardless).
    """
    op.drop_index("ix_passwordresettoken_lookup_key", table_name="passwordresettoken")
    with op.batch_alter_table("passwordresettoken") as batch_op:
        batch_op.drop_column("lookup_key")
