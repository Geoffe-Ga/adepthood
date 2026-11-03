"""Request/response schemas for the quote-promotion API.

A promotion anchors a character span of its source -- a journal entry, a Course
chapter, or a Resonance Letter (``source_kind``) -- and, optionally, folds it
into a later reflection. The client sends only anchor offsets — the server
slices and snapshots the text — so no schema here carries source body text.
``user_id`` never appears in a response.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Self

from pydantic import BaseModel, Field, model_validator

from bounds import RowIdField
from models.promoted_quote import PromotedQuoteSourceKind
from schemas.journal import JOURNAL_MESSAGE_MAX_LENGTH

#: Upper bound, in code points, on a Course chapter body and so on the offsets
#: of a quote promoted from one. Chapters run longer than any journal entry
#: (the longest vendored chapter is roughly two and a half times
#: ``JOURNAL_MESSAGE_MAX_LENGTH``), so the journal's own bound would leave the
#: end of a long chapter unquotable. Generous headroom over the longest chapter
#: shipped; ``tests/test_promotions_reading_api.py`` fails a content pin that
#: ships a longer one. The real limit is the served body's length (422
#: ``anchor_out_of_range``); this only keeps absurd integers out (#3658).
COURSE_CHAPTER_MAX_LENGTH = 100_000


class QuoteSpan(BaseModel):
    """A half-open ``[anchor_start, anchor_end)`` span of code points into a source body.

    The base of every promote payload. Only offsets are accepted; the server
    slices ``anchor_text`` from the body it holds. ``anchor_end`` must lie
    strictly past ``anchor_start`` so an empty or inverted span is rejected
    before it reaches the database. Each subclass bounds the offsets by the
    longest body its kind of source can have.
    """

    anchor_start: int
    anchor_end: int

    @model_validator(mode="after")
    def _validate_span(self) -> Self:
        """Reject a span whose end does not lie strictly past its start."""
        if self.anchor_end <= self.anchor_start:
            msg = "anchor_end must be greater than anchor_start"
            raise ValueError(msg)
        return self


class PromoteQuoteCreate(QuoteSpan):
    """Payload for promoting a span of a journal entry or a Resonance Letter.

    Both bodies are bounded by ``JOURNAL_MESSAGE_MAX_LENGTH`` (a letter by the
    essay cap, which is no larger), and so are the offsets.
    """

    anchor_start: int = Field(ge=0, le=JOURNAL_MESSAGE_MAX_LENGTH)
    anchor_end: int = Field(ge=1, le=JOURNAL_MESSAGE_MAX_LENGTH)


class PromoteChapterQuoteCreate(QuoteSpan):
    """Payload for promoting a span of a Course chapter (#3658).

    Offsets index the chapter's Markdown exactly as
    ``GET /course/content/{content_id}/body`` serves it (frontmatter already
    stripped), bounded by :data:`COURSE_CHAPTER_MAX_LENGTH`.
    """

    anchor_start: int = Field(ge=0, le=COURSE_CHAPTER_MAX_LENGTH)
    anchor_end: int = Field(ge=1, le=COURSE_CHAPTER_MAX_LENGTH)


class PromotionUpdate(BaseModel):
    """Payload for (un)folding a promoted quote into a reflection.

    ``included_in_entry_id`` is required with no default, so an empty ``{}`` body
    is a 422. A ``null`` value is valid and returns the quote to pending.
    """

    included_in_entry_id: RowIdField | None


class PromotedQuoteResponse(BaseModel):
    """A promoted quote as returned to its owner.

    ``source_kind`` names where the quote was lifted from, and exactly the
    matching source id is set: ``source_entry_id`` for an entry quote,
    ``source_content_id`` for a Course quote (null once its chapter was
    pruned), ``source_marginalia_id`` for a letter quote. ``user_id`` is
    intentionally excluded — the caller already knows its own identity and
    exposing surrogate keys aids enumeration.
    """

    id: int
    source_kind: PromotedQuoteSourceKind
    source_entry_id: int | None
    source_content_id: int | None
    source_marginalia_id: int | None
    anchor_start: int
    anchor_end: int
    anchor_text: str
    pending: bool
    # True once a source-body edit deleted/mutated the anchored passage so the
    # quote could no longer re-anchor; a stale quote stays for the user to resolve.
    stale: bool


class PromotionStatusFilter(StrEnum):
    """Which promoted quotes ``GET /promotions`` returns, by fold state.

    ``pending`` quotes still wait for a review, ``included`` ones were folded
    into one, and ``all`` (the default) returns both.
    """

    PENDING = "pending"
    INCLUDED = "included"
    ALL = "all"


class PromotedQuoteListItemResponse(PromotedQuoteResponse):
    """A promoted quote as listed across every source, with where it came from.

    Extends :class:`PromotedQuoteResponse` so the two quote shapes cannot drift.
    ``source_title`` and ``source_timestamp`` describe the live source, per kind:

    * ``entry`` -- the source entry's title and timestamp;
    * ``course`` -- the live chapter's title, else the title snapshotted when the
      quote was made, and the quote's own ``created_at``;
    * ``letter`` -- the title of the entry the letter's note sits on, and when
      the letter was written (the quote's ``created_at`` if it no longer is).

    ``source_stage_number`` is the Course stage of a Course quote's live
    chapter, and ``letter_entry_id`` the entry a letter quote's note sits on --
    together with ``source_content_id`` what **Open** needs to find the source.
    Both are null for every other kind. ``included_in_title`` is null unless the
    review the quote was folded into is the caller's own and still live -- a
    deleted review's title is never shown, though ``included_in_entry_id`` still
    records that the quote was used.
    """

    source_title: str | None
    source_timestamp: datetime
    source_stage_number: int | None
    letter_entry_id: int | None
    included_in_entry_id: int | None
    included_in_title: str | None
    created_at: datetime


class PromotedQuoteListResponse(BaseModel):
    """One offset page of the caller's promoted quotes, newest first."""

    items: list[PromotedQuoteListItemResponse]
    total: int
    has_more: bool
