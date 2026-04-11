"""Weekly reflection prompt schemas for request/response validation."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

PROMPT_RESPONSE_MAX_LENGTH = 10_000


class PromptDetail(BaseModel):
    """A single weekly prompt with its question and response status."""

    week_number: int
    question: str
    has_responded: bool
    response: str | None = None
    timestamp: datetime | None = None


class PromptSubmit(BaseModel):
    """Payload for submitting a response to a weekly prompt."""

    response: str = Field(min_length=1, max_length=PROMPT_RESPONSE_MAX_LENGTH)


class PromptListResponse(BaseModel):
    """Paginated list of prompt responses."""

    items: list[PromptDetail]
    total: int
    has_more: bool
