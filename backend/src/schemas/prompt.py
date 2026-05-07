"""Weekly reflection prompt schemas for request/response validation."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, field_validator

PROMPT_RESPONSE_MAX_LENGTH = 10_000

# BUG-PROMPT-005: ``min_length`` counts raw characters including
# whitespace, so a payload of three spaces was previously accepted as a
# valid reflection.  Rejecting anything shorter than this threshold
# after ``str.strip()`` blocks the trivial auto-advance script without
# preventing genuinely terse-but-meaningful entries.
_PROMPT_RESPONSE_MIN_STRIPPED_LENGTH = 10


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

    @field_validator("response")
    @classmethod
    def _reject_whitespace_only(cls, value: str) -> str:
        """Reject responses whose stripped length falls below the threshold."""
        if len(value.strip()) < _PROMPT_RESPONSE_MIN_STRIPPED_LENGTH:
            msg = (
                f"response must contain at least {_PROMPT_RESPONSE_MIN_STRIPPED_LENGTH} "
                "non-whitespace characters"
            )
            raise ValueError(msg)
        return value


class PromptListResponse(BaseModel):
    """Paginated list of prompt responses."""

    items: list[PromptDetail]
    total: int
    has_more: bool
