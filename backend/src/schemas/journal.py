"""Journal entry schemas for request/response validation."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class JournalMessageCreate(BaseModel):
    """Payload for creating a user journal message.

    ``user_id`` and ``sender`` are set server-side — clients cannot
    impersonate other users or forge bot messages.
    """

    message: str
    is_stage_reflection: bool = False
    is_practice_note: bool = False
    is_habit_note: bool = False
    practice_session_id: int | None = None
    user_practice_id: int | None = None


class JournalBotMessageCreate(BaseModel):
    """Payload for storing a BotMason response (internal use)."""

    message: str
    user_id: int
    is_stage_reflection: bool = False
    is_practice_note: bool = False
    is_habit_note: bool = False
    practice_session_id: int | None = None
    user_practice_id: int | None = None


class JournalMessageResponse(BaseModel):
    """Full journal entry returned to clients."""

    id: int
    message: str
    sender: str
    user_id: int
    timestamp: datetime
    is_stage_reflection: bool
    is_practice_note: bool
    is_habit_note: bool
    practice_session_id: int | None
    user_practice_id: int | None


class JournalListResponse(BaseModel):
    """Paginated list of journal entries."""

    items: list[JournalMessageResponse]
    total: int
    has_more: bool
