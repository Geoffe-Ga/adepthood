"""Response schemas for the hierarchical-reflection API.

These DTOs shape the two read surfaces of the nested reflection calendar: the
``/reflections/due`` peek at what layer has just come due, and the
``/reflections/sources`` feed of the raw material that composes a given
reflection. ``user_id`` never appears in any of them.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class PromotedQuoteSummary(BaseModel):
    """A promoted quote as it rides along with its source entry in a tier feed.

    ``pending`` is True while the quote has not yet been folded into any
    reflection (its ``included_in_entry_id`` is NULL).
    """

    id: int
    anchor_start: int
    anchor_end: int
    anchor_text: str
    pending: bool


class ReflectionSourceItem(BaseModel):
    """One resolved source feeding a reflection: a child reflection or a raw entry.

    ``reflection_level`` is populated only for a REFLECTION item (naming which
    child layer stood in for its span) and is ``None`` for a raw daily entry.
    """

    kind: str
    id: int
    title: str | None
    timestamp: datetime
    body: str
    reflection_level: str | None
    promoted_quotes: list[PromotedQuoteSummary]


class ReflectionSourcesResponse(BaseModel):
    """The ordered source material feeding one reflection.

    Deliberately unpaginated: a single tier's feed is at most a few dozen
    items, so the whole set is returned in one call. Pagination can be layered
    on later if a wider layer's feed ever grows past a comfortable page.
    """

    items: list[ReflectionSourceItem]


class ReflectionDue(BaseModel):
    """The reflection that has just come due, with its calendar window.

    ``existing_entry_id`` names the caller's live reflection already claiming
    this scope, or ``None`` when the layer is still open to compose.
    """

    level: str
    scope_key: str
    window_start: datetime
    window_end: datetime
    existing_entry_id: int | None


class ReflectionDueResponse(BaseModel):
    """Envelope for the due-reflection peek; ``due`` is ``None`` when nothing is due."""

    due: ReflectionDue | None
