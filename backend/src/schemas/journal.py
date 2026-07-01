"""Journal entry schemas for request/response validation."""

from __future__ import annotations

from datetime import datetime
from typing import Self

from pydantic import BaseModel, Field, model_validator

from models.journal_entry import EntryStatus, JournalClassification, JournalTag

JOURNAL_MESSAGE_MAX_LENGTH = 10_000


class JournalMessageCreate(BaseModel):
    """Payload for creating a user journal message.

    ``user_id`` and ``sender`` are set server-side — clients cannot
    impersonate other users or forge bot messages.
    """

    message: str = Field(min_length=1, max_length=JOURNAL_MESSAGE_MAX_LENGTH)
    tag: JournalTag = JournalTag.FREEFORM
    classification: JournalClassification = JournalClassification.PERSONAL
    practice_session_id: int | None = None
    user_practice_id: int | None = None


class JournalEntryUpdate(BaseModel):
    """Partial update for a journal entry (PATCH).

    Every field is optional; an empty payload is rejected (422) so a no-op PATCH
    can't silently bump ``updated_at``. ``message`` is re-sanitized server-side.
    """

    message: str | None = Field(default=None, min_length=1, max_length=JOURNAL_MESSAGE_MAX_LENGTH)
    title: str | None = Field(default=None, max_length=200)
    status: EntryStatus | None = None
    classification: JournalClassification | None = None

    @model_validator(mode="after")
    def _require_at_least_one_field(self) -> Self:
        if (
            self.message is None
            and self.title is None
            and self.status is None
            and self.classification is None
        ):
            msg = "at least one field must be provided"
            raise ValueError(msg)
        return self


class JournalMessageResponse(BaseModel):
    """Full journal entry returned to clients.

    ``user_id`` is intentionally excluded — the client already knows its own
    identity and exposing surrogate keys aids enumeration (BUG-JOURNAL-004).
    """

    id: int
    title: str | None
    message: str
    status: EntryStatus
    sender: str
    timestamp: datetime
    updated_at: datetime
    tag: str
    classification: JournalClassification
    practice_session_id: int | None
    user_practice_id: int | None


class JournalListResponse(BaseModel):
    """Paginated list of journal entries."""

    items: list[JournalMessageResponse]
    total: int
    has_more: bool
