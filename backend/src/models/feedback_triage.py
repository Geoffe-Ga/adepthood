"""What an operator adds to a beta report: private notes and an append-only trail.

Both tables hang off :class:`models.feedback.FeedbackReport` and both are the
operator's, not the reporter's. That single fact decides every policy they
carry:

* **Never in the reporter's export.** :mod:`domain.data_export` classifies both
  as ``Omitted``. A note is an operator's reading of somebody's report; handing
  it to the reporter in their archive would turn a private working note into a
  message to them.
* **Gone with the report.** Both are ``ERASE`` through ``feedbackreport`` in
  :mod:`domain.account_deletion`, and :func:`services.feedback_triage.purge_feedback_reports`
  deletes them explicitly before the reports on the retention sweep -- the
  ``CASCADE`` declared here is what an operator in ``psql`` gets, but the suite
  runs on SQLite, where it never fires.
* **The actor outlives nothing.** ``author_admin_id`` / ``actor_admin_id`` are
  ``SET NULL`` and named in the deletion policy's ``clear_columns``: deleting an
  administrator's account keeps the trail of what was done and forgets who did
  it.

A note body is prose an operator typed about a person's report, so it is held
to the same standard as the report's own words: ``EncryptedString`` at rest,
redacted from every rendering by :class:`ProseRedactingRepr`, bounded by
:data:`FEEDBACK_NOTE_MAX_LENGTH`. An event carries no prose at all -- its
``old_state`` / ``new_state`` hold a status, a public reference or a note id,
each content-free by construction.
"""

from __future__ import annotations

import enum
from datetime import UTC, datetime
from typing import Final

from sqlalchemy import Column, DateTime, String
from sqlmodel import Field, SQLModel

from models._prose_repr import ProseRedactingRepr
from models.feedback import enum_check
from services.journal_encryption import EncryptedString

# Long enough for a careful operator paragraph; the same ceiling the reporter's
# own answers carry, so neither side of the conversation can out-write the other.
FEEDBACK_NOTE_MAX_LENGTH: Final = 2000

# A status, a ``FB-…`` public reference, or a note id: the longest is 11
# characters, and the column is bounded well above that without being a place
# prose could be put.
TRIAGE_STATE_MAX_LENGTH: Final = 32

# Clears the longest action name.
_ACTION_COLUMN_WIDTH: Final = 24

_NOTE_TABLE: Final = "feedbacknote"
_EVENT_TABLE: Final = "feedbacktriageevent"


class FeedbackTriageAction(enum.StrEnum):
    """Every kind of change an operator can make to a report. One event each."""

    DUPLICATE_LINKED = "duplicate_linked"
    DUPLICATE_UNLINKED = "duplicate_unlinked"
    NOTE_ADDED = "note_added"
    STATUS_CHANGED = "status_changed"


class FeedbackNote(ProseRedactingRepr, SQLModel, table=True):
    """One private operator note on one report."""

    __tablename__ = _NOTE_TABLE

    id: int | None = Field(default=None, primary_key=True)
    report_id: int = Field(foreign_key="feedbackreport.id", index=True, ondelete="CASCADE")
    author_admin_id: int | None = Field(
        default=None,
        foreign_key="user.id",
        index=True,
        nullable=True,
        ondelete="SET NULL",
    )
    body: str = Field(sa_column=Column(EncryptedString(), nullable=False))
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )


class FeedbackTriageEvent(SQLModel, table=True):
    """One operator mutation of one report: who, when, what, from, to.

    Append-only. No route updates or deletes a row here; the only way one
    leaves is with its report.
    """

    __tablename__ = _EVENT_TABLE
    __table_args__ = (enum_check(_EVENT_TABLE, "action", FeedbackTriageAction),)

    id: int | None = Field(default=None, primary_key=True)
    report_id: int = Field(foreign_key="feedbackreport.id", index=True, ondelete="CASCADE")
    actor_admin_id: int | None = Field(
        default=None,
        foreign_key="user.id",
        index=True,
        nullable=True,
        ondelete="SET NULL",
    )
    action: str = Field(sa_column=Column(String(_ACTION_COLUMN_WIDTH), nullable=False))
    old_state: str | None = Field(
        default=None,
        sa_column=Column(String(TRIAGE_STATE_MAX_LENGTH), nullable=True),
    )
    new_state: str | None = Field(
        default=None,
        sa_column=Column(String(TRIAGE_STATE_MAX_LENGTH), nullable=True),
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
