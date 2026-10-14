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

from datetime import date, timedelta
from typing import Literal

from domain.constants import PROGRAM_START_BACKDATE_WINDOW_DAYS

__all__ = ["ProgramStartVerdict", "program_start_verdict"]

ProgramStartVerdict = Literal["ok", "future", "too_early"]


def program_start_verdict(
    chosen: date, *, today: date, account_created: date
) -> ProgramStartVerdict:
    """Classify ``chosen`` against the pickable range; both endpoints are inclusive."""
    if chosen > today:
        return "future"
    if chosen < account_created - timedelta(days=PROGRAM_START_BACKDATE_WINDOW_DAYS):
        return "too_early"
    return "ok"
