"""Encrypt journalentry.message at rest.

Revision ID: b7c8d9e0f1a2
Revises: d0e1f2a3b4c5
Create Date: 2026-06-26 00:00:00.000000

Closes:

* audit-destub-05b: make journal encryption at rest real. ``message`` becomes a
  ``Text`` column (Fernet ciphertext exceeds the old 10k plaintext bound) and,
  when ``JOURNAL_ENCRYPTION_KEYS`` is configured, existing plaintext rows are
  encrypted in place. With no key configured this is a type-only change (the
  encrypt helper is a passthrough), so the migration is safe on un-keyed
  environments. Reversible: downgrade decrypts rows back and restores the
  bounded ``String(10000)`` column.
"""

from collections.abc import Callable, Sequence

import sqlalchemy as sa
from alembic import op

# NOTE: ``services.journal_encryption`` is imported lazily inside upgrade/
# downgrade — not at module top. ``src`` is only on sys.path when env.py has run
# (during a real migration), whereas tools that merely *load* the revision file
# (e.g. resolve_prev_revision) would hit ModuleNotFoundError on a top-level import.

# revision identifiers, used by Alembic.
revision: str = "b7c8d9e0f1a2"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "d0e1f2a3b4c5"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_MESSAGE_MAX = 10_000
_journal = sa.table("journalentry", sa.column("id", sa.Integer), sa.column("message", sa.Text))


def _retype_message(*, to_text: bool) -> None:
    """Alter ``message`` between ``Text`` and ``String(10000)`` (SQLite-safe)."""
    new_type: sa.types.TypeEngine[str] = sa.Text() if to_text else sa.String(length=_MESSAGE_MAX)
    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        with op.batch_alter_table("journalentry") as batch:
            batch.alter_column("message", type_=new_type, existing_nullable=False)
    else:
        op.alter_column("journalentry", "message", type_=new_type, existing_nullable=False)


# Rows per keyset page. Larger = fewer round-trips but a longer per-statement
# lock hold; 1000 balances both for a typical journal table.
_BATCH_SIZE = 1_000


def _transform_rows(transform: Callable[[str], str]) -> None:
    """Apply ``transform`` (encrypt | decrypt) to every row's ``message``.

    A no-op when no key is configured: the encrypt/decrypt helpers pass plaintext
    through unchanged, so un-keyed environments only get the type change.
    Keyset-paginated (``WHERE id > last_id`` in batches) so the whole table is
    never loaded into memory — safe for a journal table that has grown large.
    """
    bind = op.get_bind()
    last_id = 0
    while True:
        batch = bind.execute(
            sa.select(_journal.c.id, _journal.c.message)
            .where(_journal.c.id > last_id)
            .order_by(_journal.c.id)
            .limit(_BATCH_SIZE)
        ).fetchall()
        if not batch:
            break
        for row_id, message in batch:
            last_id = row_id
            if message is None:
                continue
            new_value = transform(message)
            if new_value != message:
                bind.execute(
                    sa.update(_journal).where(_journal.c.id == row_id).values(message=new_value)
                )


def upgrade() -> None:
    from services.journal_encryption import encrypt

    _retype_message(to_text=True)
    _transform_rows(encrypt)


def downgrade() -> None:
    from services.journal_encryption import decrypt

    _transform_rows(decrypt)
    _retype_message(to_text=False)
