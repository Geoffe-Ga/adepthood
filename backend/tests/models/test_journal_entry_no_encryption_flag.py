"""Guards for JournalEntry's encryption-at-rest wiring (audit-destub-05b).

``message`` is wired for encryption at rest via ``EncryptedString`` rather than
a hollow ``ENCRYPTION_AT_REST_ENABLED`` boolean (the ``EncryptedString`` type
decorator encrypts on write / decrypts on read when a key is configured). This
file pins two things: the flag must stay gone, and the mapped ``message`` column
must keep its ``EncryptedString`` type. Behavioral round-trip and rotation
coverage lives in ``tests/services/test_journal_encryption.py``.
"""

from __future__ import annotations

from typing import cast

from sqlalchemy import Table
from sqlalchemy import inspect as sa_inspect

import models.journal_entry as journal_entry_module
from models.journal_entry import JournalEntry
from services.journal_encryption import EncryptedString


def test_hollow_encryption_flag_is_removed() -> None:
    """Encryption is a property of the column type, not a drift-prone flag."""
    assert not hasattr(journal_entry_module, "ENCRYPTION_AT_REST_ENABLED")


def test_message_column_is_encrypted_at_rest() -> None:
    """The mapped ``message`` column must use ``EncryptedString`` and stay non-null.

    This pins the encrypt-on-write / decrypt-on-read wiring declared on the
    model; it fails if ``message`` reverts to a plain ``str``/``Text`` column.
    """
    table = cast("Table", sa_inspect(JournalEntry).local_table)
    column = table.columns["message"]
    assert isinstance(column.type, EncryptedString)
    assert column.nullable is False
