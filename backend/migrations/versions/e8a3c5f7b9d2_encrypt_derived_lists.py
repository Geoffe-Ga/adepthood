"""Encrypt the embedding and the vault tags: two lists derived from a person's writing.

Revision ID: e8a3c5f7b9d2
Revises: b1937b21d2f9
Create Date: 2026-10-14 00:00:00.000000

``corpusfragment.embedding`` (a float array computed from the encrypted
``content``) and ``journalentry.vault_tags`` (the frequency / Wavelength-phase
labels a Creek Vault returned for an entry) were stored in the clear beside the
ciphertext they describe, and the privacy policy said so. The owner chose to
encrypt them (#3263). Each becomes ``Text`` holding the ``EncryptedString``
ciphertext of the list's JSON -- the model's ``EncryptedJSONList`` type.

On PostgreSQL the retype itself turns each stored list into its JSON text
(``array_to_json`` for the float array, a plain cast for the JSON column), and
every non-NULL row is then encrypted in place, keyset-paginated. NULL stays
NULL. On SQLite the types are advisory and a JSON column already holds JSON
text, so only the row transform runs. With no ``JOURNAL_ENCRYPTION_KEYS``
configured the encrypt helper is a passthrough, so an un-keyed environment gets
the type change and keeps the JSON text, which the new type reads unchanged.

Nothing in production writes an embedding today, so ``corpusfragment.embedding``
is expected to be NULL on every row; the upgrade logs how many non-NULL values
it moved per column so the deploy log confirms it rather than this docstring.

Reversible: ``downgrade`` decrypts every row back to its JSON text and restores
the float array (a JSON array of numbers becomes an array literal by swapping
its brackets for braces) and the JSON column.
"""

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# NOTE: ``services.journal_encryption`` is imported lazily inside upgrade/
# downgrade -- not at module top. ``src`` is only on sys.path when env.py has run
# (during a real migration), whereas tools that merely *load* the revision file
# (e.g. resolve_prev_revision) would hit ModuleNotFoundError on a top-level import.

# revision identifiers, used by Alembic.
revision: str = "e8a3c5f7b9d2"  # pragma: allowlist secret
down_revision: str | Sequence[str] | None = "b1937b21d2f9"  # pragma: allowlist secret
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

logger = logging.getLogger("alembic.runtime.migration")

# Rows per keyset page, matching ``a6b7c8d9e0f2`` and ``d4e5f6a7b8ca``.
_BATCH_SIZE = 1_000


@dataclass(frozen=True)
class _ListColumn:
    """One list column to convert, and how PostgreSQL moves it to and from text."""

    table: str
    column: str
    original_type: sa.types.TypeEngine[object]
    #: ``USING`` expression turning the original value into its JSON text.
    to_text_using: str
    #: ``USING`` expression turning the JSON text back into the original type.
    from_text_using: str


_COLUMNS: tuple[_ListColumn, ...] = (
    _ListColumn(
        "corpusfragment",
        "embedding",
        postgresql.ARRAY(sa.Float()),
        "array_to_json(embedding)::text",
        "translate(embedding, '[]', '{}')::double precision[]",
    ),
    _ListColumn(
        "journalentry",
        "vault_tags",
        sa.JSON(),
        "vault_tags::text",
        "vault_tags::json",
    ),
)


def _retype(spec: _ListColumn, *, to_text: bool) -> None:
    """Alter one column between ``Text`` and its original list type (PostgreSQL only)."""
    if op.get_bind().dialect.name != "postgresql":
        # SQLite types are advisory and the stored JSON text is already what
        # the new type reads, so only the data transform runs.
        return
    op.alter_column(
        spec.table,
        spec.column,
        type_=sa.Text() if to_text else spec.original_type,
        existing_nullable=True,
        postgresql_using=spec.to_text_using if to_text else spec.from_text_using,
    )


def _transform_rows(spec: _ListColumn, transform: Callable[[str], str | None]) -> int:
    """Apply ``transform`` to every non-NULL value; return how many rows it rewrote.

    ``transform`` returns ``None`` for a value that needs no rewrite. Keyset-
    paginated (``WHERE id > last_id``) so a large table is never loaded at once.
    """
    bind = op.get_bind()
    table = sa.table(spec.table, sa.column("id", sa.Integer), sa.column(spec.column, sa.Text))
    target = table.c[spec.column]
    last_id = 0
    rewritten = 0
    while True:
        batch = bind.execute(
            sa.select(table.c.id, target)
            .where(table.c.id > last_id, target.is_not(None))
            .order_by(table.c.id)
            .limit(_BATCH_SIZE)
        ).fetchall()
        if not batch:
            return rewritten
        for row_id, value in batch:
            last_id = row_id
            new_value = transform(value)
            if new_value is not None and new_value != value:
                bind.execute(
                    sa.update(table).where(table.c.id == row_id).values({spec.column: new_value})
                )
                rewritten += 1


def upgrade() -> None:
    from services.journal_encryption import encrypt, is_ciphertext

    def _encrypt(value: str) -> str | None:
        # A value already marked is left alone, so a re-run never double-encrypts.
        return None if is_ciphertext(value) else encrypt(value)

    for spec in _COLUMNS:
        _retype(spec, to_text=True)
        moved = _transform_rows(spec, _encrypt)
        logger.info("encrypted %d non-NULL %s.%s value(s)", moved, spec.table, spec.column)


def downgrade() -> None:
    from services.journal_encryption import decrypt

    for spec in _COLUMNS:
        # Decrypt first: the JSON text is what the restored type casts from.
        _transform_rows(spec, decrypt)
        _retype(spec, to_text=False)
