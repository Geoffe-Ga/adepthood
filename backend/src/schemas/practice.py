"""Practice-related schemas."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from domain.constants import TOTAL_STAGES as MAX_STAGE_NUMBER

PRACTICE_NAME_MAX_LENGTH = 255
PRACTICE_DESCRIPTION_MAX_LENGTH = 2_000
PRACTICE_INSTRUCTIONS_MAX_LENGTH = 10_000
PRACTICE_REFLECTION_MAX_LENGTH = 5_000

MAX_DURATION_MINUTES = 24 * 60

# Server-side bounds for ``PracticeSessionCreate`` timestamps (BUG-PRACTICE-006,
# BUG-SCHEMA-008).  Sessions cannot end more than this far in the future
# (clock-skew tolerance) and cannot start more than this far in the past
# (backdate cap).  ``MAX_SESSION_DURATION`` rejects implausibly long sessions
# that would otherwise inflate streak / week-count math.
MAX_FUTURE_SKEW = timedelta(seconds=60)
MAX_BACKDATE_WINDOW = timedelta(hours=24)
MAX_SESSION_DURATION = timedelta(hours=8)

# -- Practice ---------------------------------------------------------------


class PracticeResponse(BaseModel):
    """Public representation of a practice."""

    id: int
    stage_number: int
    name: str
    description: str
    instructions: str
    default_duration_minutes: float
    submitted_by_user_id: int | None = None
    approved: bool


class PracticeCreate(BaseModel):
    """Payload for submitting a new user-created practice."""

    stage_number: int = Field(ge=1, le=MAX_STAGE_NUMBER)
    name: str = Field(min_length=1, max_length=PRACTICE_NAME_MAX_LENGTH)
    description: str = Field(max_length=PRACTICE_DESCRIPTION_MAX_LENGTH)
    instructions: str = Field(max_length=PRACTICE_INSTRUCTIONS_MAX_LENGTH)
    default_duration_minutes: float = Field(gt=0, le=MAX_DURATION_MINUTES)


# -- UserPractice -----------------------------------------------------------


class UserPracticeCreate(BaseModel):
    """Payload for selecting a practice for a stage."""

    practice_id: int
    stage_number: int = Field(ge=1, le=MAX_STAGE_NUMBER)


class UserPracticeResponse(BaseModel):
    """Public representation of a user-practice selection."""

    id: int
    user_id: int
    practice_id: int
    stage_number: int
    start_date: date
    end_date: date | None = None


class PracticeSessionSummary(BaseModel):
    """Minimal session info for embedding in user-practice detail."""

    id: int
    duration_minutes: float
    timestamp: datetime
    reflection: str | None = None


class UserPracticeDetail(BaseModel):
    """User-practice with session history."""

    id: int
    user_id: int
    practice_id: int
    stage_number: int
    start_date: date
    end_date: date | None = None
    sessions: list[PracticeSessionSummary]


# -- PracticeSession --------------------------------------------------------


class PracticeSessionCreate(BaseModel):
    """Payload for logging a practice session.

    Server-derived duration: clients send ISO ``started_at``/``ended_at``
    (timezone-aware) and the backend computes ``duration_minutes``
    (BUG-PRACTICE-006, BUG-SCHEMA-008).  Legacy clients that still send
    ``duration_minutes`` are rejected with 422 via ``extra="forbid"`` so the
    bug cannot resurface invisibly on a stale build.

    ``user_id`` is derived from the authenticated user's token.
    """

    model_config = ConfigDict(extra="forbid")

    user_practice_id: int
    started_at: datetime
    ended_at: datetime
    reflection: str | None = Field(default=None, max_length=PRACTICE_REFLECTION_MAX_LENGTH)

    @model_validator(mode="after")
    def _check_times(self) -> Self:
        if self.started_at.tzinfo is None or self.ended_at.tzinfo is None:
            msg = "started_at and ended_at must be timezone-aware ISO timestamps"
            raise ValueError(msg)
        if self.ended_at < self.started_at:
            msg = "ended_at must be greater than or equal to started_at"
            raise ValueError(msg)
        now = datetime.now(UTC)
        if self.ended_at > now + MAX_FUTURE_SKEW:
            msg = "ended_at cannot be in the future"
            raise ValueError(msg)
        if now - self.started_at > MAX_BACKDATE_WINDOW:
            msg = "started_at is too far in the past"
            raise ValueError(msg)
        if self.ended_at - self.started_at > MAX_SESSION_DURATION:
            msg = "session duration exceeds the maximum allowed window"
            raise ValueError(msg)
        return self

    @property
    def duration_minutes(self) -> float:
        """Server-derived duration in minutes (never client-supplied)."""
        return (self.ended_at - self.started_at).total_seconds() / 60


class PracticeSessionResponse(BaseModel):
    """Public representation of a practice session."""

    id: int
    user_id: int
    user_practice_id: int
    duration_minutes: float
    timestamp: datetime
    reflection: str | None = None
