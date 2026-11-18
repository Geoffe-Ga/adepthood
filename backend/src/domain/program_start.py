"""The range a person may pick their own program start date from (issue #3097).

The owner decided on 2026-10-07 that the person picks their start date: the
anchor every calendar derivation keys off is theirs to choose when it is first
set and to change afterwards. The choice is a local CALENDAR date, not an
instant -- the calendar counts local midnights (:func:`domain.program_calendar.elapsed_days`),
so a date is all the person can meaningfully mean, and the router stores its
local midnight.

The range is closed at both ends:

* **No later than one whole program after today**
  (:data:`domain.constants.PROGRAM_START_FORWARD_WINDOW_DAYS`, issue #3725).
  A future day used to be refused because every reader floored at day zero, so
  it would have looked like a choice and changed nothing until it silently
  arrived. It now changes something visible: until the day comes the program
  has not begun (:func:`domain.program_calendar.days_until_start`) -- nothing
  on the ladder auto-unlocks and the Course withholds its first chapter -- or,
  for a new pass opened while another runs, that pass is pending and the one
  before it keeps running until the day before.
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

from domain.constants import (
    PROGRAM_START_BACKDATE_WINDOW_DAYS,
    PROGRAM_START_FORWARD_WINDOW_DAYS,
)

__all__ = [
    "PassStartVerdict",
    "ProgramStartBounds",
    "ProgramStartVerdict",
    "pass_start_bounds",
    "pass_start_verdict",
    "program_start_bounds",
    "program_start_verdict",
    "verdict_within",
]

ProgramStartVerdict = Literal["ok", "future", "too_early"]
PassStartVerdict = Literal["ok", "future", "too_early", "before_current_start"]


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
        latest=today + timedelta(days=PROGRAM_START_FORWARD_WINDOW_DAYS),
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


def pass_start_bounds(
    bounds: ProgramStartBounds, *, current_pass_start: date
) -> ProgramStartBounds:
    """The range a NEW pass may start in: ``bounds``, floored at the running pass's start.

    A pass ends the day before the next one starts, so a new pass that began
    before the running one would end that one before it began and overlap the
    record of the passes behind it. Starting on the very day the running pass
    did is allowed: that pass ran no days, as when begin-again runs on the day
    a pass opened.
    """
    return ProgramStartBounds(
        earliest=max(bounds.earliest, current_pass_start), latest=bounds.latest
    )


def pass_start_verdict(
    chosen: date, bounds: ProgramStartBounds, *, current_pass_start: date
) -> PassStartVerdict:
    """Classify a new pass's ``chosen`` start against ``bounds`` and the running pass.

    The program range is checked first so a day outside it keeps the refusal
    the program-start PUT gives; only a day inside it but before the running
    pass is ``before_current_pass``.
    """
    verdict = verdict_within(chosen, bounds)
    if verdict == "ok" and chosen < current_pass_start:
        return "before_current_start"
    return verdict
