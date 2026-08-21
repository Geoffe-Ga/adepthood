"""Encrypt every remaining column that holds journal text.

Revision ID: d4e5f6a7b8ca
Revises: c3d4e5f6a7b9
Create Date: 2026-08-21 00:00:00.000000

``journalentry.message`` has been ciphertext since ``b7c8d9e0f1a2``, but the same
sentences are copied into other columns that were never brought along: the title
the user gave the entry, the passage a margin note anchors to (with the note and
essay written about it), the passage a completion suggestion snapshots (with its
label, which is that passage sanitized), and a weekly prompt response — which is
written into ``journalentry.message`` byte-for-byte in the same transaction. A
plaintext copy beside the ciphertext is the copy a stolen dump yields, so each
becomes an ``EncryptedString`` column: ``Text`` (a Fernet token is ~1.3x the
plaintext plus the marker) with existing rows encrypted in place.

With no ``JOURNAL_ENCRYPTION_KEYS`` configured the encrypt helper is a
passthrough, so on an un-keyed environment this is a type-only change.

Reversible: ``downgrade`` decrypts every row back and restores the bounded
``String`` columns. The plaintext caps stay enforced at the write boundary
(the schema layer and the resonance / detection sanitizers), which is where they
already were -- a bounded DB column could not hold the ciphertext.
"""

from collections.abc import Callable, Sequence
from dataclasses import dataclass

import sqlalchemy as sa
from alembic import op

# NOTE: ``services.journal_encryption`` is imported lazily inside upgrade/
# downgrade -- not at module top. ``src`` is only on sys.path when env.py has run
# (during a real migration), whereas tools that merely *load* the revision file
# (e.g. resolve_prev_revision) would hit ModuleNotFoundError on a top-level import.

# revision identifiers, used by Alembic.
revision: str = "d4e5f6a7b8ca"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "c3d4e5f6a7b9"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Rows per keyset page. Larger = fewer round-trips but a longer per-statement
# lock hold; 1000 balances both, matching ``b7c8d9e0f1a2``.
_BATCH_SIZE = 1_000


@dataclass(frozen=True)
class _EncryptedColumn:
    """One column to convert, and the bound its plaintext had before."""

    table: str
    column: str
    plaintext_max: int
    nullable: bool


# Every column carrying journal text that this revision converts. The
# ``plaintext_max`` values are the pre-existing ``String`` bounds, restored
# verbatim on downgrade.
_COLUMNS: tuple[_EncryptedColumn, ...] = (
    _EncryptedColumn("journalentry", "title", 200, nullable=True),
    _EncryptedColumn("marginalia", "anchor_text", 280, nullable=False),
    _EncryptedColumn("marginalia", "note", 600, nullable=False),
    _EncryptedColumn("marginalia", "essay", 10_000, nullable=True),
    _EncryptedColumn("completionsuggestion", "label", 255, nullable=False),
    _EncryptedColumn("completionsuggestion", "anchor_text", 280, nullable=False),
    _EncryptedColumn("promptresponse", "response", 10_000, nullable=False),
)


def _table_for(spec: _EncryptedColumn) -> sa.TableClause:
    """A minimal table clause addressing ``spec``'s id + target column."""
    return sa.table(spec.table, sa.column("id", sa.Integer), sa.column(spec.column, sa.Text))


def _retype(spec: _EncryptedColumn, *, to_text: bool) -> None:
    """Alter one column between ``Text`` and its original bounded ``String``."""
    new_type: sa.types.TypeEngine[str] = (
        sa.Text() if to_text else sa.String(length=spec.plaintext_max)
    )
    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        # SQLite types are advisory and a batch recreate would have to reproduce
        # every CHECK constraint on these tables by hand; the width change is a
        # no-op there, so only the data transform runs.
        return
    op.alter_column(
        spec.table,
        spec.column,
        type_=new_type,
        existing_nullable=spec.nullable,
    )


def _transform_rows(spec: _EncryptedColumn, transform: Callable[[str], str]) -> None:
    """Apply ``transform`` (encrypt | decrypt) to every row's target column.

    A no-op when no key is configured: the encrypt/decrypt helpers pass plaintext
    through unchanged, so un-keyed environments only get the type change.
    Keyset-paginated (``WHERE id > last_id`` in batches) so a large table is
    never loaded into memory at once.
    """
    bind = op.get_bind()
    table = _table_for(spec)
    target = table.c[spec.column]
    last_id = 0
    while True:
        batch = bind.execute(
            sa.select(table.c.id, target)
            .where(table.c.id > last_id)
            .order_by(table.c.id)
            .limit(_BATCH_SIZE)
        ).fetchall()
        if not batch:
            break
        for row_id, value in batch:
            last_id = row_id
            if value is None:
                continue
            new_value = transform(value)
            if new_value != value:
                bind.execute(
                    sa.update(table).where(table.c.id == row_id).values({spec.column: new_value})
                )


def upgrade() -> None:
    from services.journal_encryption import encrypt

    for spec in _COLUMNS:
        # Widen first: the ciphertext does not fit the old bound.
        _retype(spec, to_text=True)
        _transform_rows(spec, encrypt)


def downgrade() -> None:
    from services.journal_encryption import decrypt

    for spec in _COLUMNS:
        # Decrypt first: the plaintext is what fits the restored bound.
        _transform_rows(spec, decrypt)
        _retype(spec, to_text=False)
