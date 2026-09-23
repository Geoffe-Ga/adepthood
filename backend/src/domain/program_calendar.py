"""Date-derived program calendar — the backend mirror of the frontend anchor.

Issue #386: PR #384 made the frontend treat one program-start anchor as
canonical — every screen derives stage/week from
``programStartDate`` + ``STAGE_DURATIONS_DAYS``.  The backend's gating
used different models (prompt-completion counts for weeks, the validated
advancement chain for stages), so the server could 403 a week or stage
the calendar says is open.  These helpers compute the same calendar
server-side; the gating call sites combine them with the existing models
via ``max(...)`` so time can OPEN access but never revoke what
advancement already granted — and never let a client skip past the
calendar.
"""

from __future__ import annotations

from bisect import bisect_right
from datetime import UTC, datetime, timedelta
from itertools import accumulate
from typing import TYPE_CHECKING

from domain.constants import (
    DAYS_PER_WEEK,
    STAGE_DURATIONS_DAYS,
    TOTAL_PROGRAM_DAYS,
    TOTAL_STAGES,
)
from domain.dates import day_bounds_in_tz, ensure_aware, to_user_date
from domain.weekly_prompts import TOTAL_WEEKS

if TYPE_CHECKING:
    from models.stage_progress import StageProgress


def elapsed_days(anchor: datetime, now: datetime, *, tz: str | None = None) -> int:
    """Whole CALENDAR days between the anchor's local date and ``now``'s local date.

    Counted in ``tz`` (UTC when ``tz`` is None) and floored at zero for
    clock skew.  Both operands are converted to their local calendar date
    via :func:`domain.dates.to_user_date` and subtracted, so the result is
    the number of midnights crossed in the user's zone — matching the
    frontend's local-midnight convention — rather than a UTC timedelta
    anchored to the anchor's wall-clock time-of-day.

    Shared by every date-derived program helper (this module's calendar
    math and :mod:`domain.reflection_hierarchy`'s due-date ladder) so the
    naive/aware normalization and the clock-skew floor live in exactly one
    place.  ``to_user_date`` rejects naive inputs, so both operands are
    wrapped in :func:`domain.dates.ensure_aware` (SQLite reads anchors back
    naive).
    """
    delta = to_user_date(tz, ensure_aware(now)) - to_user_date(tz, ensure_aware(anchor))
    return max(0, delta.days)


def program_week_bounds(
    anchor: datetime, weeks: range, *, tz: str | None = None
) -> tuple[datetime, datetime]:
    """The half-open ``[start, end)`` window a span of program weeks covers.

    ``weeks`` is the ``range(first, last + 1)`` a reflection scope spans.  Both
    bounds are LOCAL MIDNIGHTS in ``tz`` (UTC when ``tz`` is None), derived from
    the anchor's own local calendar date by whole-day arithmetic — the same
    arithmetic :func:`elapsed_days` uses to decide which program week a
    timestamp falls in.  That is the point: a query window and a week label
    computed from two different clocks disagree at the edges, and entries fall
    between them (issue #2886).

    ``end`` is the first instant of the day AFTER the span's final day, so range
    queries stay half-open: ``WHERE col >= start AND col < end``.  Because the
    bounds step seven calendar days at a time rather than a fixed 168 hours, a
    week spanning a daylight-saving transition is still seven local days — the
    23- and 25-hour days :func:`domain.dates.day_bounds_in_tz` documents.  Both
    bounds come back normalized to UTC (that helper's job), which SQLite's
    lexical comparison of ISO strings requires.
    """
    anchor_date = to_user_date(tz, ensure_aware(anchor))
    first_day = anchor_date + timedelta(days=(weeks.start - 1) * DAYS_PER_WEEK)
    day_after_last = anchor_date + timedelta(days=(weeks.stop - 1) * DAYS_PER_WEEK)
    start, _ = day_bounds_in_tz(tz, first_day)
    end, _ = day_bounds_in_tz(tz, day_after_last)
    return start, end


def calendar_week(anchor: datetime, now: datetime | None = None, *, tz: str | None = None) -> int:
    """The 1-based program week ``now`` falls in, clamped to the curriculum.

    Weeks advance on whole CALENDAR days between the anchor's local date
    and ``now``'s local date in ``tz`` (UTC when ``tz`` is None).
    """
    moment = now if now is not None else datetime.now(UTC)
    week = elapsed_days(anchor, moment, tz=tz) // DAYS_PER_WEEK + 1
    return min(week, TOTAL_WEEKS)


def calendar_stage(anchor: datetime, now: datetime | None = None, *, tz: str | None = None) -> int:
    """The 1-based stage ``now`` falls in, walking the duration schedule.

    Stage windows advance on whole CALENDAR days between the anchor's local
    date and ``now``'s local date in ``tz`` (UTC when ``tz`` is None).
    """
    moment = now if now is not None else datetime.now(UTC)
    remaining = elapsed_days(anchor, moment, tz=tz)
    for stage_number, duration in enumerate(STAGE_DURATIONS_DAYS, start=1):
        if remaining < duration:
            return stage_number
        remaining -= duration
    return TOTAL_STAGES


def calendar_day_in_stage(
    anchor: datetime, stage_number: int, now: datetime | None = None, *, tz: str | None = None
) -> int:
    """The 1-based day ``now`` falls on *within* ``stage_number``'s window.

    Feeds the proportional content drip (``domain.course``): a stage's
    chapters are spread across its ``STAGE_DURATIONS_DAYS`` window, so
    "how far into the stage the calendar has carried the user" is what
    decides how many are open.  Day 1 is the first day of the stage;
    values before the window opens are non-positive and values past its
    close are capped at the stage duration.  Progress is measured in whole
    CALENDAR days between the anchor's local date and ``now``'s local date
    in ``tz`` (UTC when ``tz`` is None).  Independent of advancement —
    callers combine it with ``current_stage`` so time can only widen
    access.
    """
    moment = now if now is not None else datetime.now(UTC)
    stage = min(max(stage_number, 1), TOTAL_STAGES)
    window_start = sum(STAGE_DURATIONS_DAYS[: stage - 1])
    duration = STAGE_DURATIONS_DAYS[stage - 1]
    day = elapsed_days(anchor, moment, tz=tz) - window_start + 1
    return min(day, duration)


# The 0-based program day each stage OPENS on: (0, 21, 42, ..., 210).  Derived
# from the schedule so a duration change carries through; a bisect over it turns
# "which stage is day N in?" into one lookup with no walk and no clamp.
_STAGE_OPENING_DAYS: tuple[int, ...] = (0, *accumulate(STAGE_DURATIONS_DAYS[:-1]))


def stage_position(elapsed: int) -> tuple[int, int] | None:
    """The 1-based ``(stage, day within that stage)`` ``elapsed`` program days land on.

    ``None`` once the program is over — ``elapsed >= TOTAL_PROGRAM_DAYS``.

    Deliberately NOT built on :func:`calendar_stage` and
    :func:`calendar_day_in_stage`, which both CLAMP: past the final day that
    pair reports *stage 10, day 42* forever, so anything reading it sees the
    course closing again every single day and is correct only while some
    separate end-of-program guard sits upstream of it.  Here the end of the
    program is the same guard as the position lookup, so there is one place to
    get it wrong instead of two.

    There is no negative-``elapsed`` branch because there is no negative
    ``elapsed``: :func:`elapsed_days` floors at zero for clock skew (and is the
    only producer of this argument), so day 0 is the earliest input possible.
    """
    if elapsed >= TOTAL_PROGRAM_DAYS:
        return None
    index = bisect_right(_STAGE_OPENING_DAYS, elapsed) - 1
    return (index + 1, elapsed - _STAGE_OPENING_DAYS[index] + 1)


def resolve_program_anchor(progress: StageProgress) -> datetime:
    """The user's program-start anchor.

    Prefers the stored ``program_started_at`` (set at progress creation
    and backfilled by migration from the earliest habit start date);
    legacy rows that pre-date the column fall back to the per-stage
    ``stage_started_at`` — conservative (later) for anyone past stage 1,
    which only makes the time gate stricter, never looser.

    This answers for the CURRENT cycle only: ``begin-again`` re-stamps the
    column for each new lap. A PAST cycle's anchor lives on
    ``StageProgress.past_cycle_anchors`` and is resolved through
    :mod:`domain.cycle_calendar` (issue #2894).
    """
    return progress.program_started_at or progress.stage_started_at
