"""The wire contract for private beta feedback: what may be sent, and nothing else.

Two halves, and they are held to different standards.

The account's **words** are bounded and normalised and otherwise left alone —
they are the point of the feature, and narrowing what a person is allowed to say
about their own experience would be the wrong kind of safety.

The **envelope** is an allowlist. :class:`FeedbackContext` carries exactly seven
fields, each typed narrowly enough that the shapes the issue forbids cannot be
spelled in them: a URL with a query string, a stack trace, a request or response
body, a header map, a vault address, a log bundle -- and prose disguised as a
token. ``screen`` and ``control`` are closed vocabularies
(:class:`models.feedback.FeedbackScreen`, :class:`models.feedback.FeedbackControl`)
rather than a token grammar, because the grammar alone admits
``journal.i_miss_my_father``; ``app_build`` is a version shape whose only
alphabetic suffixes are ``alpha``, ``beta`` and ``rc``. ``extra="forbid"`` publishes
``additionalProperties: false``, so the document itself says an eighth key is out
of contract and a client that adds one is refused rather than quietly trimmed.

:data:`ALLOWED_CONTEXT_KEYS` restates that set literally. It is **not** derived
from ``model_fields``, and the duplication is deliberate: the acceptance
criterion this feature owes is that adding a forbidden context field makes a
gate red, and an allowlist derived from the model asserts
``set(model_fields) == set(model_fields)``, which cannot fail for any mutation
whatsoever. Two independent declarations of the same fact is what gives the
mutation something to disagree with.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Final
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from models.feedback import (
    FEEDBACK_ANSWER_MAX_LENGTH,
    FEEDBACK_BUILD_MAX_LENGTH,
    FEEDBACK_LOCALE_MAX_LENGTH,
    FEEDBACK_SUMMARY_MAX_LENGTH,
    PUBLIC_ID_MAX_LENGTH,
    FeedbackCategory,
    FeedbackControl,
    FeedbackImpact,
    FeedbackPlatform,
    FeedbackScreen,
    FeedbackViewportClass,
)
from schemas._base import OwnedResourcePublic
from security.text_sanitize import sanitize_user_text

# The grammar every screen token is spelled in: ``journal.shelf``. The request
# field is the closed :class:`FeedbackScreen` vocabulary, which is narrower; this
# pattern stays as the shape each member must satisfy (pinned by
# ``test_every_closed_token_satisfies_its_grammar``) and as the admin inbox's
# filter grammar, which must still match rows stored before the vocabulary
# closed.
SCREEN_PATTERN: Final = r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$"

# The grammar every control token is spelled in. The request field is the closed
# :class:`FeedbackControl` vocabulary; see ``SCREEN_PATTERN``.
CONTROL_PATTERN: Final = r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$"

# A build identifier: ``1.4.2``, ``1.4.2+318``, ``2026.09.17-beta``, ``1.4``.
# Numbers and dots, then at most a numeric build or one of three named
# prerelease stages. No free-form suffix and no commit hash: either would let a
# word (``1.0.0-imissyoudad``) ride along in a field that is meant to name a
# release. Length is bounded separately, by FEEDBACK_BUILD_MAX_LENGTH.
BUILD_PATTERN: Final = r"^[0-9]+(\.[0-9]+){1,3}(\+[0-9]+|-(alpha|beta|rc)(\.[0-9]+)?)?$"

# A BCP-47 language tag narrowed to language plus optional region. Enough to
# know which translation the person was reading; not enough to be a fingerprint.
LOCALE_PATTERN: Final = r"^[a-z]{2,3}(-[A-Z]{2})?$"

# The seven fields the diagnostic envelope may carry, stated a second time and
# independently of :class:`FeedbackContext`. See this module's docstring for why
# this is written out rather than derived.
ALLOWED_CONTEXT_KEYS: Final[frozenset[str]] = frozenset(
    {
        "screen",
        "control",
        "platform",
        "app_build",
        "viewport_class",
        "locale",
        "correlation_id",
    }
)


class FeedbackContext(BaseModel):
    """The approved diagnostic envelope. Seven fields, and no eighth."""

    model_config = ConfigDict(extra="forbid")

    screen: FeedbackScreen = Field(description="The screen the report was filed from.")
    control: FeedbackControl | None = Field(
        default=None, description="The control that opened the composer."
    )
    platform: FeedbackPlatform = Field(description="Which client the report came from.")
    app_build: Annotated[
        str, Field(pattern=BUILD_PATTERN, max_length=FEEDBACK_BUILD_MAX_LENGTH)
    ] = Field(description="The build identifier the client is running.")
    viewport_class: FeedbackViewportClass = Field(description="How much room the layout had.")
    locale: Annotated[
        str | None, Field(pattern=LOCALE_PATTERN, max_length=FEEDBACK_LOCALE_MAX_LENGTH)
    ] = Field(default=None, description="BCP-47 language tag, language and optional region.")
    correlation_id: UUID | None = Field(
        default=None,
        description="Client-generated correlation id for this session's telemetry.",
    )


def _sanitize(value: str | None, max_len: int) -> str | None:
    """Normalise one prose field, or pass ``None`` through untouched."""
    if value is None:
        return None
    return sanitize_user_text(value, max_len=max_len)


class FeedbackCreate(BaseModel):
    """One submitted report: the account's words plus the approved envelope.

    Carries **no** idempotency field. The key arrives as the ``Idempotency-Key``
    header, which is where the other three idempotent surfaces on this API take
    it; putting it in the body would have made feedback the odd one out and
    would have shipped the key into the export archive alongside the prose.

    The four prose fields declare ``repr=False`` so a traceback that stringifies
    the parsed request model -- which happens well before the ORM object exists
    -- cannot reproduce what somebody wrote.
    """

    model_config = ConfigDict(extra="forbid")

    category: FeedbackCategory = Field(description="What kind of report this is.")
    impact: FeedbackImpact = Field(description="What the reported thing cost the reporter.")
    summary: str = Field(
        min_length=1,
        max_length=FEEDBACK_SUMMARY_MAX_LENGTH,
        description="One sentence naming the thing being reported.",
        repr=False,
    )
    intent: str | None = Field(
        default=None,
        max_length=FEEDBACK_ANSWER_MAX_LENGTH,
        description="What the person was trying to do, or wants to be able to do.",
        repr=False,
    )
    expected: str | None = Field(
        default=None,
        max_length=FEEDBACK_ANSWER_MAX_LENGTH,
        description="What they expected to happen.",
        repr=False,
    )
    actual: str | None = Field(
        default=None,
        max_length=FEEDBACK_ANSWER_MAX_LENGTH,
        description="What happened instead.",
        repr=False,
    )
    context: FeedbackContext = Field(description="The allowlisted diagnostic envelope.")

    @field_validator("summary")
    @classmethod
    def _clean_summary(cls, value: str) -> str:
        """Normalise the summary the way every other prose field on this API is."""
        cleaned = sanitize_user_text(value, max_len=FEEDBACK_SUMMARY_MAX_LENGTH)
        if not cleaned:
            msg = "summary must not be empty after normalization"
            raise ValueError(msg)
        return cleaned

    @field_validator("intent", "expected", "actual")
    @classmethod
    def _clean_answer(cls, value: str | None) -> str | None:
        """Normalise an optional answer, leaving an absent one absent."""
        return _sanitize(value, FEEDBACK_ANSWER_MAX_LENGTH)


class FeedbackReceipt(OwnedResourcePublic):
    """What the reporter gets back: a reference, and how the report was filed.

    Deliberately thin. No prose (the account has its own copy of what it wrote,
    and echoing it back widens the number of places it exists), no ``user_id``
    (the base class refuses it), and no administrator identity or triage note --
    those are out of scope for this issue and this DTO is the surface through
    which they would otherwise leak first.
    """

    public_id: Annotated[str, Field(max_length=PUBLIC_ID_MAX_LENGTH)] = Field(
        description="The human-readable public reference, e.g. ``FB-7K3M9Q2B``."
    )
    category: FeedbackCategory = Field(description="What kind of report this was filed as.")
    impact: FeedbackImpact = Field(description="The impact it was filed under.")
    created_at: datetime = Field(description="When the report was recorded.")
