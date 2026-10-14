"""Detached, content-free note that a deleted account's vault copy is still owed a withdrawal.

Account deletion erases every withdrawal obligation (:mod:`models.journal_withdrawal_obligation`)
with the account. An open one (``pending_delete`` / ``unconfirmed``) was the
only record that a copy of a journal page may remain in a vault, so erasing it
would forget the copy. The owner decided (2026-10-14, #3267): "Keep a detached
note (opaque vault fingerprint and entry ID only) until the vault confirms, for
at most 97 days."

So deletion copies each open obligation into this table first. A note is
detached by construction: it has no ``user_id``, no foreign key and no other
column that names or reaches the account. It holds

* ``destination`` -- the opaque fingerprint of the vault the copy went to
  (:func:`dependencies.creek_vault.vault_destination_fingerprint`), or ``None``
  for a copy that predates destination binding and so names no vault (#3095);
* ``journal_entry_id`` -- the stable id the vault's withdrawal is asked by;
* ``created_at`` -- the instant the account was deleted and the note detached,
  which is when its 97-day clock starts.

That is the whole of the state needed to finish: once the page and its account
are gone, ``pending_delete`` and ``unconfirmed`` mean the same thing -- the copy
at ``destination`` is owed a withdrawal -- so no state column is kept. A
confirmed withdrawal deletes the note outright, and
:func:`services.journal_withdrawal_note.purge_expired_withdrawal_notes` removes
any note older than the ratified 97 days, confirmed or not.

No body, title, URL, credential, content hash or account reference is stored.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, Index
from sqlmodel import Field, SQLModel

from models.journal_entry import VAULT_DESTINATION_WIDTH


class JournalWithdrawalNote(SQLModel, table=True):
    """One deleted account's owed withdrawal of one journal page's vault copy, detached."""

    __tablename__ = "journalwithdrawalnote"
    __table_args__ = (
        # An entry id is global, and an entry had one owner and so at most one
        # obligation: one note per entry keeps a repeated deletion idempotent.
        Index("ix_journalwithdrawalnote_entry_unique", "journal_entry_id", unique=True),
        Index("ix_journalwithdrawalnote_created_at", "created_at"),
    )

    id: int | None = Field(default=None, primary_key=True)
    journal_entry_id: int
    destination: str | None = Field(default=None, max_length=VAULT_DESTINATION_WIDTH)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
