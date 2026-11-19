"""Domain logic for course content drip-feed gating and progress."""

from __future__ import annotations

import logging
import math
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from domain.constants import STAGE_DURATIONS_DAYS
from domain.dates import ensure_aware, to_user_date
from domain.program_calendar import calendar_day_in_stage, days_until_start, effective_anchor
from domain.stage_authority import open_through, reanchor_program

if TYPE_CHECKING:
    from models.stage_progress import StageProgress

logger = logging.getLogger(__name__)


def compute_days_elapsed(stage_started_at: datetime, now: datetime | None = None) -> int:
    """Return whole days elapsed to ``now`` (the wall clock when None).

    A future ``stage_started_at`` clamps to 0 and logs a WARNING.
    """
    now = ensure_aware(now) if now is not None else datetime.now(UTC)
    # SQLite drops tzinfo on round-trip, so coerce naive values to UTC
    # before subtraction to avoid TypeError under the test fixture.
    stage_started_at = ensure_aware(stage_started_at)
    delta = now - stage_started_at
    if delta.total_seconds() < 0:
        logger.warning(
            "stage_started_at_in_future",
            extra={"stage_started_at": stage_started_at.isoformat(), "now": now.isoformat()},
        )
        return 0
    return delta.days


#: The drip day of a program that has not begun: before day 1, so no chapter is open.
NOT_BEGUN_DAY = 0


# -- The Course high-water mark (issue #3744) ----------------------------------
#
# The owner's decision on epic #3722: "The course work should stay at the
# highest unlocked point that the user has reached until they begin to pass
# their high water mark again, never go back down to beige in a reset, metta or
# otherwise." The mark is ``StageProgress.highest_stage_reached`` (the stage)
# with ``highest_drip_day`` (how far that stage had dripped), and the two
# functions below are the whole rule: the stage gate and the drip both read it,
# so the Courses router and the reading invitations cannot disagree. It is
# about Course access only -- ``current_stage``, the calendar and
# :func:`domain.stage_authority.open_through` (pacing for habits, practice and
# prompts) are left exactly as they were.


def course_open_through(
    progress: StageProgress | None,
    now: datetime | None = None,
    *,
    tz: str | None = None,
) -> int:
    """The highest stage whose Course reading is open to this person.

    :func:`domain.stage_authority.open_through` (the calendar and the record)
    widened by the lifetime mark: a stage once reached stays open after
    begin-again, a rescaffold or a re-pick moves the record back below it.
    """
    opened = open_through(progress, now, tz=tz)
    if progress is None:
        return opened
    return max(opened, progress.highest_stage_reached)


def held_drip_day(progress: StageProgress, stage_number: int, *, duration_days: int) -> int:
    """The drip day the lifetime mark holds open in ``stage_number``.

    Every stage below the mark is held fully open, the mark itself as far as it
    had dripped when the record last left it, and anything above it not at all
    -- there the live calendar and record are the only pacing.
    """
    mark = progress.highest_stage_reached
    if stage_number < mark:
        return duration_days
    if stage_number == mark:
        return progress.highest_drip_day
    return NOT_BEGUN_DAY


def stage_duration_days(stage_number: int) -> int:
    """Days ``stage_number`` lasts, clamped to the curriculum's ten stages."""
    index = min(max(stage_number, 1), len(STAGE_DURATIONS_DAYS)) - 1
    return STAGE_DURATIONS_DAYS[index]


def course_high_water_day(progress: StageProgress, *, now: datetime, tz: str) -> int:
    """How far the mark's own stage has dripped for ``progress`` as of ``now``.

    Monotone: the day measured already includes what the mark held, so holding
    it again never shrinks what is held.
    """
    mark = progress.highest_stage_reached
    return drip_day_in_stage(
        progress, mark, duration_days=stage_duration_days(mark), tz=tz, now=now
    )


def hold_course_high_water(progress: StageProgress, *, now: datetime, tz: str) -> None:
    """Hold how far the mark's stage has dripped, before a reset moves the record back.

    Called by the cycle loop shared by begin-again, a rescaffold and an arriving
    pending pass, immediately before it returns the record to stage 1. ``now``
    is the last moment the outgoing calendar was the one the person saw.
    Mutates in place; the caller holds the row lock and commits.
    """
    progress.highest_drip_day = course_high_water_day(progress, now=now, tz=tz)


def reanchor_keeping_course(
    progress: StageProgress, anchor: datetime, now: datetime, *, tz: str
) -> None:
    """:func:`domain.stage_authority.reanchor_program`, keeping the Course where it was.

    The first-cycle re-pick is a correction of the pass the person is in, not a
    reset, so the mark's drip is held only when the correction moves the record
    off the mark -- below it. A re-pick that leaves the record on the mark keeps
    the live drip and the not-yet-begun rule of issue #3725 exactly as they
    were; one that carries the record past it raises the mark instead.
    Mutates in place; the caller holds the row lock and commits.
    """
    reached = course_high_water_day(progress, now=now, tz=tz)
    reanchor_program(progress, anchor, now, tz=tz)
    if progress.current_stage < progress.highest_stage_reached:
        progress.highest_drip_day = reached


def drip_day_in_stage(
    progress: StageProgress,
    stage_number: int,
    *,
    duration_days: int,
    tz: str,
    now: datetime | None = None,
) -> int:
    """The 1-based day ``progress`` stands on within ``stage_number`` for the drip.

    The one rule the Course listing and the reading invitations share, so a
    chapter the listing withholds is never recommended. The day is the further
    of the live drip (:func:`_live_drip_day`) and what the lifetime mark holds
    (:func:`held_drip_day`), so neither time nor a reset can take a chapter
    back: once the new pass's own drip passes the mark, it paces as before.
    """
    held = held_drip_day(progress, stage_number, duration_days=duration_days)
    live = _live_drip_day(progress, stage_number, duration_days=duration_days, tz=tz, now=now)
    return max(held, live)


def _live_drip_day(
    progress: StageProgress,
    stage_number: int,
    *,
    duration_days: int,
    tz: str,
    now: datetime | None,
) -> int:
    """The drip day the current calendar and record give ``stage_number``.

    Advancement is honored so time can only widen access, never revoke it:

    - a **past** stage returns its full ``duration_days`` → every chapter open;
    - a program that has **not begun** (its start is still ahead, issue #3725)
      returns :data:`NOT_BEGUN_DAY` → stage 1's first chapter waits for the day;
    - the **current** stage runs on whichever is further along, the program
      calendar or how long the user has actually sat on the stage;
    - a **not-yet-current** stage the calendar has already opened uses the
      calendar day.

    The calendar counts from :func:`domain.program_calendar.effective_anchor`,
    so while a pass is pending the running one keeps pacing the Course.
    """
    if progress.current_stage > stage_number:
        return duration_days
    moment = now if now is not None else datetime.now(UTC)
    today = to_user_date(tz, ensure_aware(moment))
    if days_until_start(progress, today, tz=tz) > 0:
        return NOT_BEGUN_DAY
    anchor = effective_anchor(progress, today, tz=tz)
    calendar_day = calendar_day_in_stage(anchor, stage_number, moment, tz=tz)
    if progress.current_stage == stage_number:
        return max(calendar_day, compute_days_elapsed(progress.stage_started_at, moment) + 1)
    return calendar_day


def unlocked_chapter_count(*, total: int, duration_days: int, day_in_stage: int) -> int:
    """How many of a stage's chapters are open on ``day_in_stage``.

    The proportional drip spreads a stage's ``total`` chapters evenly
    across its ``duration_days``, so by the 1-based ``day_in_stage`` the
    user has earned ``ceil(total * day / duration)`` of them, clamped to
    ``[0, total]``.  ``ceil`` rounds up, so any open day (``day >= 1``) of
    a seeded stage (``total >= 1``) yields at least one chapter — the
    guarantee that keeps an unlocked, non-empty stage from ever rendering
    "No Content Yet".  A stage the user has moved past supplies
    ``day_in_stage >= duration_days`` and unlocks everything.
    """
    if total <= 0 or duration_days <= 0 or day_in_stage <= 0:
        return 0
    if day_in_stage >= duration_days:
        return total
    earned = math.ceil(total * day_in_stage / duration_days)
    return max(0, min(earned, total))


def enrich_content_item(
    item: dict[str, Any], *, is_locked: bool, read_content_ids: set[int]
) -> dict[str, Any]:
    """Attach lock/read status to a raw content item.

    Locked items have their ``url`` set to ``None`` so a client cannot
    fetch — or spoil — a chapter ahead of its drip release.
    """
    return {
        **item,
        "is_locked": is_locked,
        "is_read": item.get("id") in read_content_ids,
        "url": None if is_locked else item["url"],
    }


def filter_content_for_user(
    items: list[dict[str, Any]],
    *,
    unlocked_count: int,
    read_content_ids: set[int],
) -> list[dict[str, Any]]:
    """Apply proportional drip-feed gating and read status to raw items.

    ``items`` must already be in the stage's release order (ascending):
    the first ``unlocked_count`` are open and the rest are locked by
    **ordinal position**, not by ``release_day``.  Gating on position is
    what lets a non-dense ``release_day`` sequence (stage 1 skips day 11)
    still drip exactly ``unlocked_count`` chapters — ``release_day`` is
    only the sort key now, never the gate.
    """
    return [
        enrich_content_item(
            item, is_locked=position >= unlocked_count, read_content_ids=read_content_ids
        )
        for position, item in enumerate(items)
    ]


def next_unlock_day(*, total: int, duration_days: int, day_in_stage: int) -> int | None:
    """The 1-based day-in-stage the next locked chapter opens, or ``None``.

    Inverts :func:`unlocked_chapter_count`: with ``k`` chapters already
    open, the ``(k + 1)``-th opens on the first day ``D`` satisfying
    ``ceil(total * D / duration) >= k + 1`` — i.e.
    ``floor(k * duration / total) + 1``.  Returns ``None`` once every
    chapter is unlocked (including the empty-stage case).
    """
    unlocked = unlocked_chapter_count(
        total=total, duration_days=duration_days, day_in_stage=day_in_stage
    )
    if unlocked >= total:
        return None
    return (unlocked * duration_days) // total + 1
