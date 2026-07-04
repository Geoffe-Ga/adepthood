"""Shared goal check-in recording.

The streak / idempotency / milestone logic that backs ``POST /goal_completions/``
lives here so other callers (the journal resonance accept flow, #818) record a
completion through the EXACT same path — one completion per goal/day, identical
streak + milestone math — rather than reimplementing it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import cast

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError, MultipleResultsFound
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.dates import day_bounds_in_tz, today_in_tz
from domain.streaks import is_scheduled_on
from errors import bad_request
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from schemas import CheckInResult
from schemas.checkin import CheckInReasonCode
from services.streaks import (
    PendingCompletion,
    StreakScope,
    SubtractiveContext,
    check_milestones,
    compute_consecutive_streak,
    compute_streak_before_and_after,
)

logger = logging.getLogger(__name__)

_DEFAULT_THRESHOLDS = [1, 3, 7, 14, 30]

# A completion may be backfilled at most this many days into the past.
# Beyond this window a user could manufacture an arbitrarily long streak
# by logging one consecutive past day at a time.
_MAX_BACKFILL_DAYS = 30


@dataclass(frozen=True)
class _CheckInJob:
    """Inputs to ``_persist_and_build_response`` / ``_try_persist_or_idempotent``."""

    goal_id: int
    target: float
    user_id: int
    user_timezone: str
    did_complete: bool
    old_streak: int
    new_streak: int
    # The user-local calendar day the completion belongs to; stored on the row
    # as the per-user-day uniqueness key.
    target_day: date
    # Explicit completion time for a backfilled past day; ``None`` lets the
    # ``GoalCompletion`` model default (``datetime.now(UTC)``) stand.
    timestamp: datetime | None
    # Subtractive-habit context for the streak computation: a no-log day
    # on an "abstain from sugar" habit is success, not a chain break.
    # ``None`` selects the additive code path.
    subtractive: SubtractiveContext | None


async def _already_logged_on(
    session: AsyncSession,
    goal_id: int,
    user_id: int,
    user_timezone: str,
    day: date,
) -> bool:
    """Return True if a completion exists for this goal on ``day`` (user-local)."""
    start, end = day_bounds_in_tz(user_timezone, day)
    result = await session.execute(
        select(GoalCompletion.id)
        .where(
            GoalCompletion.goal_id == goal_id,
            GoalCompletion.user_id == user_id,
            GoalCompletion.timestamp >= start,
            GoalCompletion.timestamp < end,
        )
        .limit(1)
    )
    return result.scalar_one_or_none() is not None


async def _idempotent_already_logged_response(
    session: AsyncSession,
    goal_id: int,
    user_id: int,
    user_timezone: str,
    subtractive: SubtractiveContext | None = None,
) -> CheckInResult:
    """Build the ``already_logged_today`` response shape used by both fast + race paths."""
    streak = await compute_consecutive_streak(session, goal_id, user_id, user_timezone, subtractive)
    return CheckInResult(
        streak=streak,
        milestones=[],
        reason_code="already_logged_today",
    )


async def _subtractive_context_for_goal(
    session: AsyncSession, habit: Habit, posted_goal: Goal
) -> SubtractiveContext | None:
    """Build the subtractive-streak context for the habit, else ``None``.

    The check-in identifies a single goal (any tier), but the "transgression"
    line the user thinks in terms of is always the clear-tier sibling. ``None``
    selects the additive code path so additive habits behave exactly as before.

    Queries the sibling directly rather than walking ``habit.goals`` because the
    habit row is fetched with ``session.get`` (no eager relationship load), and
    touching the lazy-loaded relationship in an async context raises
    ``MissingGreenlet``.

    Filters on ``is_additive == False`` so a mixed-polarity fixture or partial
    migration that co-locates an additive clear goal under the same habit is
    rejected before it builds a wrong-shape context. ``scalar_one_or_none``
    surfaces duplicate ``clear``-tier siblings as a ``MultipleResultsFound``,
    re-raised as a stable 500.
    """
    if posted_goal.is_additive:
        return None
    result = await session.execute(
        select(Goal.target).where(
            Goal.habit_id == habit.id,
            Goal.tier == "clear",
            col(Goal.is_additive).is_(False),
        )
    )
    try:
        clear_target = result.scalar_one_or_none()
    except MultipleResultsFound as exc:
        logger.exception(
            "subtractive_check_in_duplicate_clear_goal",
            extra={"habit_id": habit.id, "user_id": habit.user_id},
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="duplicate_clear_tier_goals",
        ) from exc
    if clear_target is None:
        return None
    return SubtractiveContext(clear_threshold=clear_target, start_date=habit.start_date)


def _held_response(current_user: int, goal_id: int, old_streak: int) -> CheckInResult:
    """Return ``streak_held`` without inserting a row -- naturally idempotent on retry."""
    logger.info(
        "goal_completion_held",
        extra={"user_id": current_user, "goal_id": goal_id, "streak": old_streak},
    )
    return CheckInResult(streak=old_streak, milestones=[], reason_code="streak_held")


def _resolve_target_day(completed_on: date | None, user_timezone: str) -> date:
    """Return the calendar day to log against.

    Defaults to the user's today when ``completed_on`` is omitted. Rejects a
    future date, and a backfill older than ``_MAX_BACKFILL_DAYS`` days.
    """
    today = today_in_tz(user_timezone)
    target_day = completed_on or today
    if target_day > today:
        raise bad_request("completion_date_in_future")
    if target_day < today - timedelta(days=_MAX_BACKFILL_DAYS):
        raise bad_request("completion_date_too_old")
    return target_day


def _completion_timestamp(completed_on: date | None, user_timezone: str) -> datetime | None:
    """Stored timestamp for the completion row.

    ``None`` lets the model default (now) stand for a same-day log. For a
    backfilled day, anchors mid-day in the user's TZ so the value lands
    unambiguously inside that local calendar day regardless of DST shoulder
    days. Per-day uniqueness is keyed off ``local_day``, not this timestamp.
    """
    if completed_on is None:
        return None
    start, end = day_bounds_in_tz(user_timezone, completed_on)
    return start + (end - start) / 2


def _reason_for_streak_transition(old_streak: int, new_streak: int) -> CheckInReasonCode:
    """Map the actual streak change to a reason code (#782).

    Derived from the real (subtractive-aware) ``new_streak`` rather than the
    additive ``update_streak`` heuristic, so the flag never contradicts the
    number it ships with: a subtractive transgression that zeroes the streak
    reads ``streak_reset``, not ``streak_incremented``. (The
    ``already_logged_today`` case is handled before this point.)
    """
    if new_streak > old_streak:
        return "streak_incremented"
    if new_streak < old_streak:
        return "streak_reset"
    return "streak_held"


async def _persist_and_build_response(session: AsyncSession, job: _CheckInJob) -> CheckInResult:
    """Persist the completion and build a CheckInResult; streak values arrive pre-computed."""
    completion = GoalCompletion(
        goal_id=job.goal_id,
        user_id=job.user_id,
        local_day=job.target_day,
        completed_units=job.target if job.did_complete else 0,
    )
    if job.timestamp is not None:
        completion.timestamp = job.timestamp
    async with session.begin_nested():
        session.add(completion)
        await session.flush()
    await session.commit()
    # ``new_streak`` was computed alongside ``old_streak`` from one history read
    # (issue dedup); these are pure derivations, no DB recompute. The reason code
    # is derived from the actual transition so it can't contradict new_streak.
    reason = _reason_for_streak_transition(job.old_streak, job.new_streak)
    milestones = check_milestones(job.new_streak, _DEFAULT_THRESHOLDS, job.old_streak)
    logger.info(
        "goal_completion_recorded",
        extra={
            "user_id": job.user_id,
            "goal_id": job.goal_id,
            "did_complete": job.did_complete,
            "streak": job.new_streak,
        },
    )
    return CheckInResult(streak=job.new_streak, milestones=milestones, reason_code=reason)


async def _try_persist_or_idempotent(session: AsyncSession, job: _CheckInJob) -> CheckInResult:
    """Persist + commit, falling back to the idempotent response on a unique-index race."""
    try:
        return await _persist_and_build_response(session, job)
    except IntegrityError:
        # Rollback before the follow-up SELECT in case the integrity error
        # surfaced from the outer commit() rather than the savepoint flush --
        # SQLAlchemy marks the session as ``PendingRollbackError`` until
        # rollback() is called and any subsequent query would otherwise raise.
        await session.rollback()
        return await _idempotent_already_logged_response(
            session,
            job.goal_id,
            job.user_id,
            job.user_timezone,
            job.subtractive,
        )


@dataclass(frozen=True)
class CheckInContext:
    """An owned, loaded goal + the actor recording against it.

    Bundles the (goal, habit, user, timezone) tuple the recording helpers share
    so callers pass one context instead of four positional arguments.
    """

    goal: Goal
    habit: Habit
    user_id: int
    user_timezone: str


async def current_check_in(session: AsyncSession, ctx: CheckInContext) -> CheckInResult:
    """Current streak for an already-recorded goal, WITHOUT writing a row.

    Used for the idempotent no-op view (e.g. re-accepting an already-accepted
    suggestion) so it never logs a fresh completion.
    """
    goal_id = cast("int", ctx.goal.id)
    subtractive = await _subtractive_context_for_goal(session, ctx.habit, ctx.goal)
    streak = await compute_consecutive_streak(
        session, goal_id, ctx.user_id, ctx.user_timezone, subtractive
    )
    return CheckInResult(streak=streak, milestones=[], reason_code="already_logged_today")


async def record_goal_completion(
    session: AsyncSession,
    ctx: CheckInContext,
    *,
    did_complete: bool = True,
    completed_on: date | None = None,
) -> CheckInResult:
    """Record a check-in for an already-owned goal and return streak + milestones.

    The single source of truth for check-in recording: idempotent on the same
    (user, goal, day), with identical streak/milestone math for the
    ``POST /goal_completions/`` route and the journal accept flow (#818). The
    caller is responsible for ownership; ``ctx.goal``/``ctx.habit`` must be loaded.
    """
    # An already-owned, persisted goal always carries a PK.
    goal_id = cast("int", ctx.goal.id)
    target_day = _resolve_target_day(completed_on, ctx.user_timezone)
    subtractive = await _subtractive_context_for_goal(session, ctx.habit, ctx.goal)

    if await _already_logged_on(session, goal_id, ctx.user_id, ctx.user_timezone, target_day):
        return await _idempotent_already_logged_response(
            session, goal_id, ctx.user_id, ctx.user_timezone, subtractive
        )

    is_scheduled = is_scheduled_on(ctx.habit.notification_days, target_day.strftime("%a"))

    # Unscheduled miss holds the current streak without inserting — only the
    # pre-insert streak is needed, so compute it once here.
    if not did_complete and not is_scheduled:
        old_streak = await compute_consecutive_streak(
            session, goal_id, ctx.user_id, ctx.user_timezone, subtractive
        )
        return _held_response(ctx.user_id, goal_id, old_streak)

    # Persist path: derive pre- and post-insert streak from ONE history read.
    pending_units = ctx.goal.target if did_complete else 0.0
    old_streak, new_streak = await compute_streak_before_and_after(
        session,
        StreakScope(goal_id, ctx.user_id, ctx.user_timezone, subtractive),
        PendingCompletion(target_day, pending_units),
    )
    job = _CheckInJob(
        goal_id=goal_id,
        target=ctx.goal.target,
        user_id=ctx.user_id,
        user_timezone=ctx.user_timezone,
        did_complete=did_complete,
        old_streak=old_streak,
        new_streak=new_streak,
        target_day=target_day,
        timestamp=_completion_timestamp(completed_on, ctx.user_timezone),
        subtractive=subtractive,
    )
    return await _try_persist_or_idempotent(session, job)
