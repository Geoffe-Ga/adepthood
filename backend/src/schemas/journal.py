"""Journal entry schemas for request/response validation."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from models.journal_entry import JournalTag

JOURNAL_MESSAGE_MAX_LENGTH = 10_000


class JournalMessageCreate(BaseModel):
    """Payload for creating a user journal message.

    ``user_id`` and ``sender`` are set server-side — clients cannot
    impersonate other users or forge bot messages.
    """

    message: str = Field(max_length=JOURNAL_MESSAGE_MAX_LENGTH)
    tag: JournalTag = JournalTag.FREEFORM
    practice_session_id: int | None = None
    user_practice_id: int | None = None


class JournalBotMessageCreate(BaseModel):
    """Payload for storing a BotMason response (internal use)."""

    message: str = Field(max_length=JOURNAL_MESSAGE_MAX_LENGTH)
    user_id: int
    tag: JournalTag = JournalTag.FREEFORM
    practice_session_id: int | None = None
    user_practice_id: int | None = None


class JournalMessageResponse(BaseModel):
    """Full journal entry returned to clients."""

    id: int
    message: str
    sender: str
    user_id: int
    timestamp: datetime
    tag: str
    practice_session_id: int | None
    user_practice_id: int | None


class JournalListResponse(BaseModel):
    """Paginated list of journal entries."""

    items: list[JournalMessageResponse]
    total: int
    has_more: bool
