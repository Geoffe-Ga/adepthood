"""Practice-related schemas."""

from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel

# -- Practice ---------------------------------------------------------------


class PracticeResponse(BaseModel):
    """Public representation of a practice."""

    id: int
    stage_number: int
    name: str
    description: str
    instructions: str
    default_duration_minutes: int
    submitted_by_user_id: int | None = None
    approved: bool


class PracticeCreate(BaseModel):
    """Payload for submitting a new user-created practice."""

    stage_number: int
    name: str
    description: str
    instructions: str
    default_duration_minutes: int


# -- UserPractice -----------------------------------------------------------


class UserPracticeCreate(BaseModel):
    """Payload for selecting a practice for a stage."""

    practice_id: int
    stage_number: int


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
    duration_minutes: float
    reflection: str | None = None


class PracticeSessionResponse(BaseModel):
    """Public representation of a practice session."""

    id: int
    user_id: int
    user_practice_id: int
    duration_minutes: float
    timestamp: datetime
    reflection: str | None = None
