"""Weekly reflection prompt schemas for request/response validation."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from models.journal_entry import JOURNAL_TITLE_MAX_LENGTH

PROMPT_RESPONSE_MAX_LENGTH = 10_000

# Threshold checked *after* ``str.strip()`` so a whitespace-padded
# payload cannot dodge the bound; ``min_length`` alone counts raw
# characters and would accept three spaces as a valid reflection.
# Exported so the frontend can mirror the same bound client-side
# without duplicating the magic number.
PROMPT_RESPONSE_MIN_STRIPPED_LENGTH = 10


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
    # Optional compose title. When omitted or blank the router falls back to
    # the week's default band label; the length cap mirrors the DB column.
    title: str | None = Field(default=None, max_length=JOURNAL_TITLE_MAX_LENGTH)

    @field_validator("response")
    @classmethod
    def _reject_whitespace_only(cls, value: str) -> str:
        """Reject responses whose stripped length falls below the threshold.

        The original (unstripped) value is returned so the router's
        canonical ``sanitize_user_text`` -> NFC/strip pipeline remains
        the single normalisation step that touches the persisted bytes.
        """
        if len(value.strip()) < PROMPT_RESPONSE_MIN_STRIPPED_LENGTH:
            msg = (
                f"response must contain at least {PROMPT_RESPONSE_MIN_STRIPPED_LENGTH} "
                "non-whitespace characters"
            )
            raise ValueError(msg)
        return value


class PromptListResponse(BaseModel):
    """Paginated list of prompt responses; ``total`` is ``None`` when not requested."""

    items: list[PromptDetail]
    total: int | None
    has_more: bool
