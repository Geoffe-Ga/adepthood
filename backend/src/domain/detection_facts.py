"""The facts a detection hit may carry: how much, and on which day.

Pure companion to :mod:`domain.detection`, split out for one reason: the
rules that decide whether a model-stated amount or day may be *believed* are
substantial enough to be read on their own, and every one of them is
day-and-unit arithmetic with no notion of a row. Like ``domain.dates`` this
module imports stdlib only — it does NOT read the database, the clock, or the
user's timezone. Its caller supplies both days through :class:`DetectionClock`.

The governing rule is **drop on doubt, never drop the hit**. A writer who says
"I ran" has attested to the run; the amount and the day are extras. Anything
ambiguous — an unrecognised unit, a phrase this module cannot date, a number
that is not a number — yields ``None`` for that one field and leaves the hit
itself standing.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Protocol

from domain.dates import day_window_verdict

_DAYS_PER_WEEK = 7


@dataclass(frozen=True)
class DetectionClock:
    """The two days one detection pass resolves relative phrases against.

    ``entry_day`` is the user-local day the *entry* belongs to, which is what
    "yesterday" is measured from — a backdated entry's "yesterday" is the day
    before that entry, not the day before now. ``today`` and
    ``max_backfill_days`` bound what may be written at all: a day outside the
    backfill window is one the accept path would refuse to log, so it is
    dropped here rather than persisted and shown.
    """

    entry_day: date
    today: date
    max_backfill_days: int


class ModelFacts(Protocol):
    """Structural view of the three raw, untrusted fact fields on a draft.

    Deliberately typed ``object``: these values arrive from a model's JSON and
    have survived no validation at all. Keeping them untyped up to
    :func:`facts_from_model` is what makes that function the single place every
    drop rule lives, rather than one gate here and another one there.

    Declared read-only (properties, not bare annotations) so a *frozen*
    dataclass satisfies it -- which is what the real draft type is.
    """

    @property
    def amount(self) -> object:
        """The number the model stated, if it stated one."""

    @property
    def unit(self) -> object:
        """The word the model copied for what that number counts."""

    @property
    def when(self) -> object:
        """The relative phrase the model gave for the day."""


# Canonical unit groups. Allowlist on BOTH sides: an unrecognised token — the
# writer's or the goal's — yields ``None``, so two unknowns can never match by
# accident and be read as agreement.
#
# ``count`` is load-bearing rather than a convenience. ``POST /habits/`` seeds
# every default goal with ``target_unit="units"`` and no writer types "3 units
# of water", so without a group that lets "times" and "units" denominate the
# same thing this feature would be dormant for every habit in the default
# configuration while a test using ``target_unit="oz"`` went green.
_UNIT_GROUPS: dict[str, tuple[str, ...]] = {
    "count": ("unit", "units", "time", "times", "x"),
    "oz": ("oz", "ounce", "ounces"),
    "min": ("min", "mins", "minute", "minutes"),
    "mi": ("mi", "mile", "miles"),
    "km": ("km", "kilometer", "kilometers", "kilometre", "kilometres"),
    "rep": ("rep", "reps"),
    "session": ("session", "sessions"),
    "glass": ("glass", "glasses"),
    "cup": ("cup", "cups"),
    "page": ("page", "pages"),
}

_UNIT_CANON: dict[str, str] = {
    alias: canon for canon, aliases in _UNIT_GROUPS.items() for alias in aliases
}

# Relative phrases, as data rather than branches. Every value is an offset in
# days from ``DetectionClock.entry_day``.
_RELATIVE_OFFSETS: dict[str, int] = {
    "today": 0,
    "this morning": 0,
    "this afternoon": 0,
    "this evening": 0,
    "tonight": 0,
    "earlier": 0,
    "yesterday": -1,
    "last night": -1,
}

_WEEKDAY_INDEX: dict[str, int] = {
    "monday": 0,
    "tuesday": 1,
    "wednesday": 2,
    "thursday": 3,
    "friday": 4,
    "saturday": 5,
    "sunday": 6,
}


def normalise_unit(written: str, target_unit: str | None) -> str | None:
    """The canonical unit both tokens denominate, or ``None`` if they disagree.

    Case-insensitive and allowlist-only on both sides. ``None`` for a
    ``target_unit`` of ``None`` is what makes a practice structurally
    AMOUNT-free: a practice tracks no unit, so no amount the model states
    about one can ever be believed. It says nothing about the day, which
    :func:`resolve_when` decides without consulting the unit -- dropping that
    is the router's job, under the habit-only CHECK.
    """
    if target_unit is None:
        return None
    tracked = _UNIT_CANON.get(target_unit.strip().lower())
    stated = _UNIT_CANON.get(written.strip().lower())
    return tracked if tracked is not None and tracked == stated else None


def _relative_day(text: str, entry_day: date) -> date | None:
    """Resolve a fixed relative phrase ("yesterday") against the entry's day."""
    offset = _RELATIVE_OFFSETS.get(text)
    return None if offset is None else entry_day + timedelta(days=offset)


def _weekday_day(text: str, entry_day: date) -> date | None:
    """Resolve a weekday name to the most recent such day on or before the entry.

    A bare weekday allows the entry's own day ("I ran Friday", written on a
    Friday, means that Friday). An explicit ``last <weekday>`` on that same
    weekday means the one before, which is the only reading of "last Friday"
    written on a Friday that a person would recognise.
    """
    a_week_back = text.startswith("last ")
    index = _WEEKDAY_INDEX.get(text.removeprefix("last "))
    if index is None:
        return None
    delta = (entry_day.weekday() - index) % _DAYS_PER_WEEK
    if a_week_back and delta == 0:
        delta = _DAYS_PER_WEEK
    return entry_day - timedelta(days=delta)


def resolve_when(phrase: str, *, clock: DetectionClock) -> date | None:
    """The user-local day ``phrase`` names, or ``None`` if it names none clearly.

    Relative words anchor to ``clock.entry_day``, never to ``clock.today``, so
    a backdated entry's "yesterday" is the day before *that entry*. The result
    is then clamped through the backfill window: a day the accept path would
    refuse to log must not be persisted, served in a suggestion, or shown on a
    card, because the accept would silently log a different day instead.
    """
    text = " ".join(phrase.strip().lower().split()).removeprefix("on ")
    day = _relative_day(text, clock.entry_day) or _weekday_day(text, clock.entry_day)
    if day is None:
        return None
    verdict = day_window_verdict(day, today=clock.today, max_backfill_days=clock.max_backfill_days)
    return day if verdict == "ok" else None


def _positive_number(value: object) -> float | None:
    """A real, finite, strictly positive number, or ``None``.

    A ``bool`` is not a number, mirroring the guard on the candidate index in
    :mod:`domain.detection` — ``True`` would otherwise arrive as ``1.0``.
    Strictly positive because the column's CHECK says so, and because a zero
    or negative reaching the check-in service's explicit-delta path would
    silently shrink a day the writer meant to add to.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    numeric = float(value)
    return numeric if math.isfinite(numeric) and numeric > 0 else None


def _believable_amount(draft: ModelFacts, target_unit: str | None) -> float | None:
    """The stated amount, if its unit denominates the same thing the goal tracks."""
    unit = draft.unit
    if not isinstance(unit, str) or normalise_unit(unit, target_unit) is None:
        return None
    return _positive_number(draft.amount)


def _believable_day(draft: ModelFacts, clock: DetectionClock) -> date | None:
    """The stated day, if it is a phrase this module can date inside the window."""
    when = draft.when
    return resolve_when(when, clock=clock) if isinstance(when, str) else None


def facts_from_model(
    draft: ModelFacts, *, target_unit: str | None, clock: DetectionClock
) -> tuple[float | None, date | None]:
    """The ``(completed_units, completed_on)`` pair a draft may be believed for.

    The single place the drop-on-doubt rules live. Each field is decided
    independently, so a malformed amount never costs the entry its day and a
    phrase this module cannot date never costs it its amount — and neither
    ever costs the hit itself, which rests on the index and the quote alone.
    """
    return _believable_amount(draft, target_unit), _believable_day(draft, clock)
