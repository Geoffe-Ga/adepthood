"""Response schemas for completion-suggestion endpoints."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from models.completion_suggestion import CompletionTargetType, SuggestionStatus
from schemas.checkin import CheckInResult


class CompletionSuggestionResponse(BaseModel):
    """A single completion suggestion returned to clients.

    ``user_id`` is intentionally excluded — the client knows its own identity and
    exposing surrogate keys aids enumeration (mirrors ``MarginaliaResponse`` and
    the journal-entry response).
    """

    id: int
    journal_entry_id: int
    target_type: CompletionTargetType
    goal_id: int | None
    user_practice_id: int | None
    label: str
    anchor_start: int
    anchor_end: int
    anchor_text: str
    status: SuggestionStatus
    accepted_at: datetime | None
    created_at: datetime
    updated_at: datetime


class CompletionSuggestionListResponse(BaseModel):
    """All completion suggestions for an entry (any status)."""

    items: list[CompletionSuggestionResponse]


class AcceptSuggestionResponse(BaseModel):
    """The accepted suggestion plus the check-in it logged (streak + milestones).

    ``check_in`` is ``None`` for practice targets — a journal-attested
    ``PracticeSession`` carries no streak (#821).
    """

    suggestion: CompletionSuggestionResponse
    check_in: CheckInResult | None = None
