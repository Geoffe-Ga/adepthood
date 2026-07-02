"""Response schemas for the Return (Metta arc) endpoints.

The Return is a declinable five-week arc offered as a skillful rest. These DTOs
project the sequence, the caller's eligibility, and the caller's active arc.
``user_id`` and the surrogate row ``id`` are intentionally excluded — the caller
knows its own identity from the JWT, and surfacing the owner key would aid
enumeration.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class ReturnWeekResponse(BaseModel):
    """One week of the Return arc projected for the caller.

    Carries the focus of loving-kindness plus its warm, non-shaming title and
    framing copy — a Return week is a gentle pacing hint, never a deadline.
    """

    week_number: int
    focus: str
    title: str
    framing: str


class ReturnArcResponse(BaseModel):
    """The caller's active Return arc, without any owner key.

    ``week`` is the arc's current (or, when paused, frozen) week; ``paused``
    reflects whether the arc is resting. No ``user_id`` or row ``id`` is exposed.
    ``complete`` is True once the fifth week has fully closed — a reflective
    close, never a reward or rank.
    """

    started_at: datetime
    paused: bool
    week: int
    focus: str
    complete: bool


class MettaReturnStateResponse(BaseModel):
    """The full Return surface for the caller.

    ``eligible`` gates whether the arc may be started, ``weeks`` is the whole
    five-week sequence in order, and ``arc`` is the caller's active arc or
    ``None`` when there is none.
    """

    eligible: bool
    weeks: list[ReturnWeekResponse]
    arc: ReturnArcResponse | None
