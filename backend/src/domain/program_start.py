"""The range a person may pick their own program start date from (issue #3097).

The owner decided on 2026-10-07 that the person picks their start date: the
anchor every calendar derivation keys off is theirs to choose when it is first
set and to change afterwards. The choice is a local CALENDAR date, not an
instant -- the calendar counts local midnights (:func:`domain.program_calendar.elapsed_days`),
so a date is all the person can meaningfully mean, and the router stores its
local midnight.

The range is closed at both ends:

* **No later than today.** A future anchor would put the person before the
  program's first day, where every reader floors at day zero anyway; it would
  look like a choice and change nothing until it silently arrived.
* **No earlier than account creation minus one whole program**
  (:data:`domain.constants.PROGRAM_START_BACKDATE_WINDOW_DAYS`). Someone who
  began on paper before they signed up may say so; an anchor before that window
  would open on a cadence that had already finished.

Pure day math with no clock read: callers supply ``today`` and the account's
creation date, both already in the person's zone.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Literal

from domain.constants import PROGRAM_START_BACKDATE_WINDOW_DAYS

__all__ = [
    "ProgramStartBounds",
    "ProgramStartVerdict",
    "program_start_bounds",
    "program_start_verdict",
    "verdict_within",
]

ProgramStartVerdict = Literal["ok", "future", "too_early"]


@dataclass(frozen=True)
class ProgramStartBounds:
    """The inclusive range of dates a person may pick, both in their zone."""

    earliest: date
    latest: date


def program_start_bounds(*, today: date, account_created: date) -> ProgramStartBounds:
    """The pickable range: the one rule both the verdict and the offered window read.

    Exposed to the client on the program-calendar responses so a picker can be
    clamped to exactly what the PUT accepts, without a second copy of the rule.
    """
    return ProgramStartBounds(
        earliest=account_created - timedelta(days=PROGRAM_START_BACKDATE_WINDOW_DAYS),
        latest=today,
    )


def verdict_within(chosen: date, bounds: ProgramStartBounds) -> ProgramStartVerdict:
    """Classify ``chosen`` against an already-computed range; both ends are inclusive."""
    if chosen > bounds.latest:
        return "future"
    if chosen < bounds.earliest:
        return "too_early"
    return "ok"


def program_start_verdict(
    chosen: date, *, today: date, account_created: date
) -> ProgramStartVerdict:
    """Classify ``chosen`` against the pickable range; both endpoints are inclusive."""
    bounds = program_start_bounds(today=today, account_created=account_created)
    return verdict_within(chosen, bounds)
