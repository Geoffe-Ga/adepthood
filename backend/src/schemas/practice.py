"""Practice-related schemas."""

from __future__ import annotations

from datetime import UTC, date, datetime

from pydantic import BaseModel, Field, field_validator

from domain.constants import TOTAL_STAGES as MAX_STAGE_NUMBER

PRACTICE_NAME_MAX_LENGTH = 255
PRACTICE_DESCRIPTION_MAX_LENGTH = 2_000
PRACTICE_INSTRUCTIONS_MAX_LENGTH = 10_000
PRACTICE_REFLECTION_MAX_LENGTH = 5_000

MAX_DURATION_MINUTES = 24 * 60

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

    ``user_id`` is derived from the authenticated user's token.
    """

    user_practice_id: int
    duration_minutes: float = Field(gt=0, le=MAX_DURATION_MINUTES)
    reflection: str | None = Field(default=None, max_length=PRACTICE_REFLECTION_MAX_LENGTH)
    timestamp: datetime | None = None

    @field_validator("timestamp")
    @classmethod
    def reject_future_timestamp(cls, v: datetime | None) -> datetime | None:
        if v is not None and v > datetime.now(UTC):
            msg = "timestamp cannot be in the future"
            raise ValueError(msg)
        return v


class PracticeSessionResponse(BaseModel):
    """Public representation of a practice session."""

    id: int
    user_id: int
    user_practice_id: int
    duration_minutes: float
    timestamp: datetime
    reflection: str | None = None
