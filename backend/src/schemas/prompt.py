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
    # The compose default the client shows before the user types a title —
    # served rather than derived client-side so no client keeps its own copy
    # of the stage-band table. ``None`` only for a retired week whose stored
    # response no longer maps onto the curriculum.
    default_title: str | None = None
    # Which of the stage's prompts this week serves, or the one a stored
    # response answered. ``None`` on rows written before prompts became
    # individually addressable.
    prompt_ordinal: int | None = None


class StagePromptDetail(BaseModel):
    """One of a stage's prompts: what to write, and how often to write it.

    ``cadence`` is opaque display prose the course author writes ("Daily",
    "At least 4x per week", "Whenever they arise") and is passed through
    verbatim — it is deliberately not a schedule, an enum, or a recurrence
    rule, because the curriculum states it as prose and varies it per prompt.
    ``None`` where the chapter states no cadence at all.
    """

    ordinal: int
    title: str
    body: str
    cadence: str | None = None


class StagePromptsResponse(BaseModel):
    """Every prompt of one stage, in curriculum order."""

    stage: int
    stage_name: str
    prompts: list[StagePromptDetail]


class PromptSubmit(BaseModel):
    """Payload for submitting a response to a weekly prompt."""

    response: str = Field(min_length=1, max_length=PROMPT_RESPONSE_MAX_LENGTH)
    # Optional compose title. When omitted or blank the router falls back to
    # the week's default band label; the length cap mirrors the DB column.
    title: str | None = Field(default=None, max_length=JOURNAL_TITLE_MAX_LENGTH)
    # Which of the stage's prompts the response answers, 1-based. Omitted
    # means the prompt the week itself draws, so clients written against the
    # one-prompt-per-week contract keep working unchanged. An ordinal the
    # stage does not carry is a 404 from the router, not a wrap-around.
    prompt_ordinal: int | None = Field(default=None, ge=1)

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
