"""Which columns hold ciphertext, derived from the schema rather than listed.

The set of encrypted columns is whatever the ORM declares as
:class:`~services.journal_encryption.EncryptedString`, so a column added
tomorrow is covered by every consumer of this module (the raw at-rest canary,
the column classification test, the operator audit and the re-encrypt sweep)
without anyone remembering to add it anywhere.

This module also owns the one sanctioned *non-decrypting* view of those
columns. Reading or writing through the ORM table would run the value through
``EncryptedString`` -- decrypting what the audit needs to see raw, or
re-encrypting what the sweep has already encrypted. :func:`raw_table` types the
column as plain ``Text`` so neither happens.
"""

from __future__ import annotations

from dataclasses import dataclass
from importlib import import_module

from sqlalchemy import Integer, MetaData, Table, Text, column, table
from sqlalchemy.sql.expression import TableClause
from sqlmodel import SQLModel

from services.journal_encryption import EncryptedString

# Importing the package registers every table on ``SQLModel.metadata``; without
# it a standalone caller (the operator CLI) would see an empty schema and
# report a clean audit over nothing.
import_module("models")

#: The primary-key column every encrypted table must have. The sweep pages by
#: it (keyset cursor) and its compare-and-swap UPDATE targets one row by it.
ROW_ID_COLUMN = "id"


class EncryptionInventoryError(RuntimeError):
    """The schema breaks an invariant the audit and sweep depend on."""


@dataclass(frozen=True, order=True)
class EncryptedColumn:
    """One ``table.column`` typed ``EncryptedString``."""

    table: str
    column: str

    @property
    def qualified(self) -> str:
        """The ``table.column`` spelling used in reports and test ids."""
        return f"{self.table}.{self.column}"


def _require_integer_row_id(owner: Table) -> None:
    """Refuse a table the keyset cursor cannot page through."""
    keys = list(owner.primary_key.columns)
    if len(keys) != 1 or keys[0].name != ROW_ID_COLUMN or not isinstance(keys[0].type, Integer):
        msg = (
            f"{owner.name} holds an encrypted column but its primary key is not a "
            f"single integer {ROW_ID_COLUMN!r} column"
        )
        raise EncryptionInventoryError(msg)


def encrypted_columns(metadata: MetaData | None = None) -> tuple[EncryptedColumn, ...]:
    """Every ``EncryptedString`` column in ``metadata``, sorted by table then column.

    Args:
        metadata: The schema to read; ``None`` reads ``SQLModel.metadata``.

    Raises:
        EncryptionInventoryError: an encrypted table lacks a single integer ``id`` key.
    """
    source = SQLModel.metadata if metadata is None else metadata
    found: list[EncryptedColumn] = []
    for owner in source.tables.values():
        found.extend(_encrypted_in(owner))
    return tuple(sorted(found))


def _encrypted_in(owner: Table) -> list[EncryptedColumn]:
    """``owner``'s encrypted columns, after checking the sweep can page it."""
    found = [
        EncryptedColumn(owner.name, c.name)
        for c in owner.columns
        if isinstance(c.type, EncryptedString)
    ]
    if found:
        _require_integer_row_id(owner)
    return found


def raw_table(target: EncryptedColumn) -> TableClause:
    """A lightweight table exposing ``id`` and the column as plain ``Text``.

    Statements built on it bypass ``EncryptedString`` in both directions, so
    they see and write exactly the stored bytes.
    """
    return table(target.table, column(ROW_ID_COLUMN, Integer), column(target.column, Text))
