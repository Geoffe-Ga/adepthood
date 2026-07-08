"""Request/response schemas for the quote-promotion API.

A promotion anchors a character span of a source journal entry and, optionally,
folds it into a later reflection. The client sends only anchor offsets — the
server slices and snapshots the text — so no schema here carries entry body
text. ``user_id`` never appears in a response.
"""

from __future__ import annotations

from typing import Self

from pydantic import BaseModel, Field, model_validator


class PromoteQuoteCreate(BaseModel):
    """Payload for promoting a span of a source entry into a pending quote.

    Only offsets are accepted; the server slices ``anchor_text`` from the
    persisted body. ``anchor_end`` must lie strictly past ``anchor_start`` so an
    empty or inverted span is rejected before it reaches the database.
    """

    anchor_start: int = Field(ge=0)
    anchor_end: int = Field(ge=1)

    @model_validator(mode="after")
    def _validate_span(self) -> Self:
        """Reject a span whose end does not lie strictly past its start."""
        if self.anchor_end <= self.anchor_start:
            msg = "anchor_end must be greater than anchor_start"
            raise ValueError(msg)
        return self


class PromotionUpdate(BaseModel):
    """Payload for (un)folding a promoted quote into a reflection.

    ``included_in_entry_id`` is required with no default, so an empty ``{}`` body
    is a 422. A ``null`` value is valid and returns the quote to pending.
    """

    included_in_entry_id: int | None


class PromotedQuoteResponse(BaseModel):
    """A promoted quote as returned to its owner.

    ``user_id`` is intentionally excluded — the caller already knows its own
    identity and exposing surrogate keys aids enumeration.
    """

    id: int
    source_entry_id: int
    anchor_start: int
    anchor_end: int
    anchor_text: str
    pending: bool
