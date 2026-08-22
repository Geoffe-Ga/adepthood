"""Encrypt the prose a person writes in a practice session.

Revision ID: a6b7c8d9e0f2
Revises: b5f1a2c3d4e6
Create Date: 2026-08-22 00:00:00.000000

``d4e5f6a7b8ca`` swept every column holding a *copy* of journal text into
ciphertext. ``practicesession.reflection`` and ``practicesession.insight`` are
not copies of anything -- they are original prose, composed after a sit, in a
different surface -- so that sweep passed straight over them and left them in
the clear beside the encrypted journal. They are the same category of private,
deliberate writing, and a stolen dump reads them directly. Each becomes an
``EncryptedString`` column: ``Text`` (a Fernet token is ~1.67x the plaintext
plus the marker) with existing rows encrypted in place.

Every other column of the table is a measurement (``duration_minutes``,
``timestamp``, ``completed``) or a machine-chosen value (``mode``, drawn from a
published enum and filtered on by the insights rollup) and is untouched.

With no ``JOURNAL_ENCRYPTION_KEYS`` configured the encrypt helper is a
passthrough, so on an un-keyed environment this is a type-only change.

Reversible: ``downgrade`` decrypts every row back and restores the bounded
``String`` columns. The plaintext caps stay enforced at the write boundary (the
request schema, which is also what the OpenAPI ``maxLength`` the client reads is
generated from), which is where they already were -- a bounded DB column could
not hold the ciphertext.
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
revision: str = "a6b7c8d9e0f2"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "b5f1a2c3d4e6"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Rows per keyset page. Larger = fewer round-trips but a longer per-statement
# lock hold; 1000 balances both, matching ``b7c8d9e0f1a2`` and ``d4e5f6a7b8ca``.
_BATCH_SIZE = 1_000


@dataclass(frozen=True)
class _EncryptedColumn:
    """One column to convert, and the bound its plaintext had before."""

    table: str
    column: str
    plaintext_max: int
    nullable: bool


# The two columns this revision converts. The ``plaintext_max`` values are the
# pre-existing ``String`` bounds, restored verbatim on downgrade.
_COLUMNS: tuple[_EncryptedColumn, ...] = (
    _EncryptedColumn("practicesession", "reflection", 5_000, nullable=True),
    _EncryptedColumn("practicesession", "insight", 2_000, nullable=True),
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
        # every constraint and partial index on this table by hand; the width
        # change is a no-op there, so only the data transform runs.
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
