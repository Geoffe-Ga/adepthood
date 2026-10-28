"""Durable, content-free record that a journal page's vault copy is still owed a withdrawal.

``JournalEntry.vault_ref`` / ``vault_destination`` say a vault was offered the
page. They do not say the writer asked for the page to be deleted, so before
this table a DELETE that the vault could not confirm was forgotten the moment
it answered 503: the background sweep only knew how to withdraw Intimate
entries, and nothing ever stamped ``deleted_at`` (#3098). Nor could a writer
whose old vault was out of reach finish deleting at all (#3094).

One row per (account, journal entry) moves through a closed lifecycle:

* ``pending_delete`` -- the writer asked to delete the page and the vault has
  not yet confirmed its copy absent. The page stays live (the identical DELETE
  stays retryable) and the background sweep finishes the withdrawal and then
  the deletion, for every classification.
* ``unconfirmed`` -- the writer could not reach the vault holding the copy and
  chose to delete the page here anyway. The page is erased locally; this row
  is the only record that a copy may remain in that vault. Nothing reports the
  copy withdrawn while a row is here.
* ``confirmed`` -- the vault that received the copy confirmed it absent.

``journal_entry_id`` is deliberately not a foreign key: the obligation
describes a remote copy and must outlive any purge of the local row.
``destination`` is the opaque fingerprint of the vault the copy went to
(:func:`dependencies.creek_vault.vault_destination_fingerprint`); only that
vault's confirmation clears an ``unconfirmed`` row.

Content-free by construction: ids, a closed state, an opaque fingerprint and
timestamps. No body, title, URL, credential or content hash is stored.
"""

from __future__ import annotations

import enum
from datetime import UTC, datetime

from sqlalchemy import CheckConstraint, Column, DateTime, Index
from sqlmodel import Field, SQLModel

from models.journal_entry import VAULT_DESTINATION_WIDTH

_STATE_WIDTH = 16


class JournalWithdrawalState(enum.StrEnum):
    """Closed lifecycle of one journal page's owed vault withdrawal."""

    PENDING_DELETE = "pending_delete"
    UNCONFIRMED = "unconfirmed"
    CONFIRMED = "confirmed"


#: States that still owe the vault a withdrawal; the sweep works these.
OPEN_STATES: tuple[str, ...] = (
    JournalWithdrawalState.PENDING_DELETE.value,
    JournalWithdrawalState.UNCONFIRMED.value,
)

_STATES = tuple(state.value for state in JournalWithdrawalState)


class JournalWithdrawalObligation(SQLModel, table=True):
    """One account's owed withdrawal of one journal page's vault copy."""

    __tablename__ = "journalwithdrawalobligation"
    __table_args__ = (
        CheckConstraint(
            "state IN (" + ", ".join(f"'{state}'" for state in _STATES) + ")",
            name="ck_journalwithdrawalobligation_state_valid",
        ),
        Index(
            "ix_journalwithdrawalobligation_user_entry_unique",
            "user_id",
            "journal_entry_id",
            unique=True,
        ),
        Index("ix_journalwithdrawalobligation_state", "state"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE")
    journal_entry_id: int
    state: str = Field(
        default=JournalWithdrawalState.PENDING_DELETE.value,
        max_length=_STATE_WIDTH,
    )
    destination: str | None = Field(default=None, max_length=VAULT_DESTINATION_WIDTH)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    confirmed_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
