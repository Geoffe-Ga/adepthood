"""Journal entry schemas for request/response validation."""

from __future__ import annotations

from datetime import datetime
from typing import Self

from pydantic import BaseModel, Field, model_validator

from domain.constants import TOTAL_STAGES
from domain.reflection_hierarchy import ReflectionLevel, scope_weeks
from models.journal_entry import EntryStatus, JournalClassification, JournalTag

JOURNAL_MESSAGE_MAX_LENGTH = 10_000

# An Aspect tag is a stage 1..TOTAL_STAGES; the bounds are derived from the
# curriculum length so they can't drift from it.
ASPECT_MIN = 1
ASPECT_MAX = TOTAL_STAGES


def _validate_chord_shape(primary: int | None, secondary: int | None) -> None:
    """Enforce the chord shape shared by create and update payloads.

    A secondary Aspect is only meaningful atop a primary, and a chord's two
    notes must differ. Raises ``ValueError`` on a secondary with no primary, or
    a secondary equal to the primary.
    """
    if secondary is None:
        return
    if primary is None:
        msg = "secondary_aspect requires a primary_aspect"
        raise ValueError(msg)
    if secondary == primary:
        msg = "secondary_aspect must differ from primary_aspect"
        raise ValueError(msg)


def _validate_reflection_scope(level: ReflectionLevel | None, key: str | None) -> None:
    """Enforce the both-or-neither reflection-scope pairing and its key grammar.

    The layer and its ``c{cycle}:{token}`` key are an atomic pair: supplying
    exactly one is rejected. When both are present the key is run through
    :func:`scope_weeks`, whose ``ValueError`` for a malformed key, a
    level/token mismatch, or an out-of-range index surfaces here as a 422.
    """
    if (level is None) != (key is None):
        msg = "reflection_level and reflection_scope_key must be set together"
        raise ValueError(msg)
    if level is None or key is None:
        return
    scope_weeks(level, key)


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
    primary_aspect: int | None = Field(default=None, ge=ASPECT_MIN, le=ASPECT_MAX)
    secondary_aspect: int | None = Field(default=None, ge=ASPECT_MIN, le=ASPECT_MAX)
    reflection_level: ReflectionLevel | None = None
    reflection_scope_key: str | None = None

    @model_validator(mode="after")
    def _validate_chord(self) -> Self:
        _validate_chord_shape(self.primary_aspect, self.secondary_aspect)
        _validate_reflection_scope(self.reflection_level, self.reflection_scope_key)
        return self


class JournalEntryUpdate(BaseModel):
    """Partial update for a journal entry (PATCH).

    Every field is optional; an empty payload is rejected (422) so a no-op PATCH
    can't silently bump ``updated_at``. ``message`` is re-sanitized server-side.
    """

    message: str | None = Field(default=None, min_length=1, max_length=JOURNAL_MESSAGE_MAX_LENGTH)
    title: str | None = Field(default=None, max_length=200)
    status: EntryStatus | None = None
    classification: JournalClassification | None = None
    primary_aspect: int | None = Field(default=None, ge=ASPECT_MIN, le=ASPECT_MAX)
    secondary_aspect: int | None = Field(default=None, ge=ASPECT_MIN, le=ASPECT_MAX)
    reflection_level: ReflectionLevel | None = None
    reflection_scope_key: str | None = None

    @model_validator(mode="after")
    def _require_at_least_one_field(self) -> Self:
        # An explicit null still counts as "provided" (it clears a field), so
        # gate on whether ANY field was supplied — not on their values. This
        # lets a PATCH that nulls the chord through while still rejecting {}.
        if not self.model_fields_set:
            msg = "at least one field must be provided"
            raise ValueError(msg)
        _validate_chord_shape(self.primary_aspect, self.secondary_aspect)
        _validate_reflection_scope(self.reflection_level, self.reflection_scope_key)
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
    primary_aspect: int | None = None
    secondary_aspect: int | None = None
    reflection_level: str | None = None
    reflection_scope_key: str | None = None


class JournalListResponse(BaseModel):
    """Paginated list of journal entries."""

    items: list[JournalMessageResponse]
    total: int
    has_more: bool
