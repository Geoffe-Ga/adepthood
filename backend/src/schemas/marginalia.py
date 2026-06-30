"""Response schemas for resonance + marginalia endpoints."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from models.marginalia import MarginaliaKind, MarginaliaStatus
from schemas.completion_suggestion import CompletionSuggestionResponse


class MarginaliaResponse(BaseModel):
    """A single margin note returned to clients.

    ``user_id`` is intentionally excluded — the client already knows its own
    identity and exposing surrogate keys aids enumeration (mirrors the journal
    entry response).
    """

    id: int
    journal_entry_id: int
    kind: MarginaliaKind
    anchor_start: int
    anchor_end: int
    anchor_text: str
    note: str
    essay: str | None
    essay_generated_at: datetime | None
    status: MarginaliaStatus
    created_at: datetime
    updated_at: datetime


class ResonanceResponse(BaseModel):
    """Result of a resonance pass: the new notes plus refreshed wallet balances.

    ``suggestions`` carries any completion suggestions detected on the same pass
    (additive, best-effort — empty when none are found or detection failed).
    """

    marginalia: list[MarginaliaResponse]
    suggestions: list[CompletionSuggestionResponse] = []
    remaining_messages: int
    remaining_balance: int
    monthly_reset_date: datetime


class MarginaliaListResponse(BaseModel):
    """All marginalia for an entry (active + stale)."""

    items: list[MarginaliaResponse]
