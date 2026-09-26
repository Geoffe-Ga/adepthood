"""Response schemas for the hierarchical-reflection API.

These DTOs shape the three read surfaces of the nested reflection calendar: the
``/reflections/due`` peek at what layer has just come due, the
``/reflections/current`` list of every layer still in progress, and the
``/reflections/sources`` feed of the raw material that composes a given
reflection. ``user_id`` never appears in any of them.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from domain.cycle_calendar import CycleAnchorStatus


class PromotedQuoteSummary(BaseModel):
    """A promoted quote as it rides along with its source entry in a sources feed.

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
    """The ordered source material feeding one reflection, and the period it covers.

    ``window_start`` / ``window_end`` are the half-open ``[start, end)`` bounds
    the server actually filtered on — local midnights in the caller's own
    timezone, with the END EXCLUSIVE (the first instant of the day after the
    span's final day). They are published so the client can name the review
    period without re-deriving it from the scope key and drifting out of step
    with the feed (issue #2886). A scope naming an earlier cycle is measured
    from THAT cycle's own retained anchor and its end is clamped to the local
    midnight of the day the user began again, so consecutive cycles abut at one
    shared instant instead of overlapping (issue #2894).

    Both bounds are ``None`` whenever no window could be drawn, and
    ``anchor_status`` names which of the four causes applies. It is published as
    the :class:`domain.cycle_calendar.CycleAnchorStatus` enum rather than a bare
    string so the four members reach the OpenAPI document: typed as ``str`` the
    contract carried no enumeration at all, and renaming a member or adding a
    fifth cause changed nothing a client could notice. The members are:
    ``recorded`` (the bounds are real), ``unrecorded`` (that cycle's anchor was
    destroyed by ``begin-again`` before #2894 and cannot be reconstructed),
    ``unstarted`` (the caller has not reached that cycle), or ``no_program``
    (the caller has no program progress at all). The client needs the
    distinction to tell "nothing was written in this period" apart from "this
    period cannot be rebuilt" — without it both read as one silent empty feed.

    Deliberately unpaginated: a single scope's feed is at most a few dozen
    items, so the whole set is returned in one call. Pagination can be layered
    on later if a wider layer's feed ever grows past a comfortable page.
    """

    level: str
    scope_key: str
    window_start: datetime | None
    window_end: datetime | None
    anchor_status: CycleAnchorStatus
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


class ReflectionCurrentScope(ReflectionDue):
    """One reflection scope in progress today, offered for an early review.

    It carries exactly the fields of :class:`ReflectionDue` -- subclassed so a
    scope offered in the early-review picker and the same scope offered as due
    can never be shaped differently -- but it is published as its own named
    component, so a client names what it holds (in progress, not due) rather
    than borrowing the due peek's type. ``existing_entry_id`` names the
    caller's live review (draft or finished) already claiming the scope, so the
    client offers to continue it rather than start a second one. No
    ``user_id`` is carried.
    """


class ReflectionCurrentResponse(BaseModel):
    """The reflection scopes in progress for the caller today (issue #2867).

    ``scopes`` is ordered week, stage, section, course. It carries no section
    throughout the section-less final stage, is empty for a caller who has not
    started the program, and holds the course alone once the program is over,
    so a late Course Review can still be written.
    """

    scopes: list[ReflectionCurrentScope]
