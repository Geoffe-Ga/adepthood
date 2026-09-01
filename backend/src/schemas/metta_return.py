"""Response schemas for the Return (Metta arc) endpoints.

The Return is a declinable five-week arc offered as a skillful rest. These DTOs
project the sequence, the caller's eligibility, and the caller's active arc.
``user_id`` and the surrogate row ``id`` are intentionally excluded — the caller
knows its own identity from the JWT, and surfacing the owner key would aid
enumeration.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from bounds import RowIdField

# Upper bound on how many habits one release request may name. A generous cap
# that no real caller reaches, present only to reject pathological payloads
# before any DB work.
MAX_RELEASE_BATCH = 50


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


class ReleaseHabitsRequest(BaseModel):
    """A request to release (or re-commit) a batch of the caller's habits.

    ``habit_ids`` names the habits to act on; it must hold between one and
    :data:`MAX_RELEASE_BATCH` ids. An id the caller does not own, that does not
    exist, or that is not eligible for the action is silently skipped, so an
    unowned id and a nonexistent id are indistinguishable in the response.
    """

    habit_ids: list[RowIdField] = Field(min_length=1, max_length=MAX_RELEASE_BATCH)


class ReleasedHabitResponse(BaseModel):
    """One released habit projected for the caller, without any owner key.

    Carries the habit's ``name`` and ``icon`` so the caller can render the
    release without a second lookup, plus ``recommitted`` — ``True`` once the
    habit has been re-committed in this arc. No ``user_id`` or surrogate row
    ``id`` is exposed, matching this module's DTO discipline.
    """

    habit_id: int
    name: str
    icon: str
    recommitted: bool


class MettaReturnStateResponse(BaseModel):
    """The full Return surface for the caller.

    ``eligible`` gates whether the arc may be started, ``weeks`` is the whole
    five-week sequence in order, ``arc`` is the caller's active arc or ``None``
    when there is none, ``offer_dismissed`` is whether the caller has waved
    away the offer for the current episode, and ``released_habits`` is every
    habit the caller has released, across all their arcs (empty when they have
    released none).

    ``released_habits`` deliberately outlives the arc that produced it. A
    release is a soft pause on a habit rather than a fact about an arc, so a
    habit released in an arc the caller has since left must stay visible for the
    client to offer it back — scoping the list to the active arc made those
    habits unrecoverable through the surface that paused them. Each entry's
    ``recommitted`` flag says whether it is still resting.
    """

    eligible: bool
    weeks: list[ReturnWeekResponse]
    arc: ReturnArcResponse | None
    offer_dismissed: bool
    released_habits: list[ReleasedHabitResponse]
