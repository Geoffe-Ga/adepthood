"""Wire shapes for the administrator's beta feedback inbox.

The detail view keeps three kinds of information apart, because they have three
different authors and three different privacy stories:

* :class:`FeedbackReporterSaid` -- the tester's own words. Only ever rendered to
  an administrator; the reporter already has them.
* :class:`FeedbackAppAttached` -- the allowlisted envelope the client attached.
  The one place ``correlation_id`` is shown, so an operator can find the
  session's telemetry; it never appears in the inbox list or in a draft.
* :class:`FeedbackOperatorAdded` -- triage state, duplicate links, notes and the
  audit trail. Written by administrators, read by administrators, never on the
  receipt and never in the reporter's export.

No shape here carries ``user_id`` or an email address. An operator triages a
report, not a person; if a report ever needs its reporter contacted, that is a
different tool with a different audit story.

Every prose-bearing field declares ``repr=False`` so a traceback that renders a
response model cannot reproduce what somebody wrote.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from bounds import RowIdField
from models.feedback import (
    PUBLIC_ID_MAX_LENGTH,
    PUBLIC_ID_PATTERN,
    FeedbackCategory,
    FeedbackImpact,
    FeedbackStatus,
)
from models.feedback_triage import FEEDBACK_NOTE_MAX_LENGTH, FeedbackTriageAction
from security.text_sanitize import sanitize_user_text

# How many notes one draft may cite. A draft is a summary for a public tracker,
# not a transcript of the operator's working file.
MAX_DRAFT_NOTES: Final = 20

# The operator's own words for a draft. The title stays short enough that the
# ``[category] `` prefix still fits under the draft's title ceiling; the summary
# has the same ceiling as a note.
OPERATOR_TITLE_MAX_LENGTH: Final = 100
OPERATOR_SUMMARY_MAX_LENGTH: Final = FEEDBACK_NOTE_MAX_LENGTH

_PublicId = Annotated[str, Field(pattern=PUBLIC_ID_PATTERN, max_length=PUBLIC_ID_MAX_LENGTH)]


class AdminCapabilities(BaseModel):
    """What the signed-in administrator may do. Reaching this at all means admin."""

    feedback_triage: bool = Field(description="Whether the beta feedback inbox is available.")


class FeedbackTriageSummary(BaseModel):
    """One inbox row: enough to choose what to open, and no prose or identity."""

    public_id: str = Field(description="The report's public reference.")
    status: FeedbackStatus = Field(description="Where the report stands in triage.")
    category: FeedbackCategory = Field(description="What kind of report it is.")
    impact: FeedbackImpact = Field(description="What the reported thing cost the reporter.")
    screen: str = Field(description="The canonical screen token it was filed from.")
    app_build: str = Field(description="The build the reporter was running.")
    created_at: datetime = Field(description="When the report was recorded.")
    duplicate_of: str | None = Field(
        default=None, description="Public reference of the report this one repeats, if any."
    )


class FeedbackReporterSaid(BaseModel):
    """The tester's own words, exactly as stored."""

    summary: str = Field(description="The one-sentence summary.", repr=False)
    intent: str | None = Field(default=None, description="What they were trying to do.", repr=False)
    expected: str | None = Field(default=None, description="What they expected.", repr=False)
    actual: str | None = Field(default=None, description="What happened instead.", repr=False)


class FeedbackAppAttached(BaseModel):
    """The allowlisted diagnostic envelope the client attached."""

    screen: str
    control: str | None
    platform: str
    app_build: str
    viewport_class: str
    locale: str | None
    correlation_id: str | None = Field(
        description="Client correlation id, for finding the session's telemetry. Operator-only."
    )
    created_at: datetime


class FeedbackOperatorNote(BaseModel):
    """One private operator note."""

    id: int
    body: str = Field(repr=False)
    created_at: datetime


class FeedbackTriageEventPublic(BaseModel):
    """One row of the append-only triage trail."""

    action: FeedbackTriageAction
    old_state: str | None
    new_state: str | None
    created_at: datetime


class FeedbackOperatorAdded(BaseModel):
    """Everything administrators have added to the report."""

    status: FeedbackStatus
    duplicate_of: str | None = Field(
        description="Public reference of the canonical report, or null if none (or if it is gone)."
    )
    duplicates: list[str] = Field(description="Public references of reports marked as this one.")
    notes: list[FeedbackOperatorNote]
    events: list[FeedbackTriageEventPublic]


class FeedbackTriageDetail(BaseModel):
    """One report, with its three sources kept apart, its fingerprint and siblings."""

    public_id: str
    category: FeedbackCategory
    impact: FeedbackImpact
    reporter_said: FeedbackReporterSaid
    app_attached: FeedbackAppAttached
    operator_added: FeedbackOperatorAdded
    fingerprint: str = Field(description="Read-time digest of category, screen, control, family.")
    siblings: list[FeedbackTriageSummary] = Field(
        description="Other reports sharing the fingerprint. Suggestions only; nothing is merged."
    )
    allowed_transitions: list[FeedbackStatus] = Field(
        description="The statuses this report may move to next, per the server's table."
    )


class TransitionCommand(BaseModel):
    """Move the report to ``status``, if the transition table allows it."""

    model_config = ConfigDict(extra="forbid")

    action: Literal["transition"]
    status: FeedbackStatus


class LinkDuplicateCommand(BaseModel):
    """Mark the report a duplicate of ``target_public_id``. Status is left alone."""

    model_config = ConfigDict(extra="forbid")

    action: Literal["link_duplicate"]
    target_public_id: _PublicId = Field(description="The canonical report's public reference.")


class UnlinkDuplicateCommand(BaseModel):
    """Clear the report's duplicate link."""

    model_config = ConfigDict(extra="forbid")

    action: Literal["unlink_duplicate"]


class AddNoteCommand(BaseModel):
    """Attach one private operator note."""

    model_config = ConfigDict(extra="forbid")

    action: Literal["add_note"]
    body: str = Field(
        min_length=1,
        max_length=FEEDBACK_NOTE_MAX_LENGTH,
        description="The note. Private to administrators.",
        repr=False,
    )

    @field_validator("body")
    @classmethod
    def _clean_body(cls, value: str) -> str:
        """Normalise the note the way every other prose field on this API is."""
        cleaned = sanitize_user_text(value, max_len=FEEDBACK_NOTE_MAX_LENGTH)
        if not cleaned.strip():
            msg = "body must not be empty after normalization"
            raise ValueError(msg)
        return cleaned


# One audited change to a report. A single command route rather than one route
# per verb: every command is exactly one event in the trail, and the admin
# surface stays small enough that the DAST allow-list -- which cannot probe a
# role-gated route and so must excuse it -- stays a minority of the app.
FeedbackTriageCommand = Annotated[
    TransitionCommand | LinkDuplicateCommand | UnlinkDuplicateCommand | AddNoteCommand,
    Field(discriminator="action"),
]


def _operator_text(value: str, max_len: int, field: str) -> str:
    """Normalise one piece of operator text, refusing one that normalises to nothing."""
    cleaned = sanitize_user_text(value, max_len=max_len)
    if not cleaned.strip():
        msg = f"{field} must not be empty after normalization"
        raise ValueError(msg)
    return cleaned


class FeedbackDraftRequest(BaseModel):
    """The operator's own title and summary, and which notes, if any, to quote.

    ``title`` and ``summary`` are required and are the only prose a draft
    carries besides selected notes. There is no fallback: a request without
    them is refused, and the reporter's words are never used in their place.
    They are used to render this one response and are never stored.
    """

    model_config = ConfigDict(extra="forbid")

    title: str = Field(
        min_length=1,
        max_length=OPERATOR_TITLE_MAX_LENGTH,
        description="The issue title, in the operator's words.",
        repr=False,
    )
    summary: str = Field(
        min_length=1,
        max_length=OPERATOR_SUMMARY_MAX_LENGTH,
        description="What is wrong and how it shows, in the operator's words.",
        repr=False,
    )
    note_ids: list[RowIdField] = Field(
        default_factory=list,
        max_length=MAX_DRAFT_NOTES,
        description="Notes on THIS report to include. Omitted notes never appear.",
    )

    @field_validator("title")
    @classmethod
    def _clean_title(cls, value: str) -> str:
        """Normalise the operator's title."""
        return _operator_text(value, OPERATOR_TITLE_MAX_LENGTH, "title")

    @field_validator("summary")
    @classmethod
    def _clean_summary(cls, value: str) -> str:
        """Normalise the operator's summary."""
        return _operator_text(value, OPERATOR_SUMMARY_MAX_LENGTH, "summary")


class FeedbackIssueDraft(BaseModel):
    """A GitHub issue draft. Returned for copying; nothing is published."""

    title: str = Field(repr=False)
    markdown: str = Field(repr=False)
    source_public_ids: list[str]
