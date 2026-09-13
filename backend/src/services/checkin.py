"""Shared goal check-in recording.

The streak / accumulation / milestone logic that backs
``POST /goal_completions/`` lives here so other callers (the journal resonance
accept flow, #818) record a completion through the EXACT same path — one stored
row per goal/day, identical streak + milestone math — rather than reimplementing
it. Legacy amount-less calls stay idempotent; explicit signed amounts adjust the
row on every call.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta
from typing import cast

from fastapi import HTTPException, status
from sqlalchemy import case, func, update
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
    subtractive_context_for_goals,
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
    habit_id: int
    completed_units: float
    explicit_units: bool
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


@dataclass(frozen=True)
class _ResponseScope:
    """Identity, calendar, and polarity needed to build a check-in response."""

    goal_id: int
    habit_id: int
    user_id: int
    user_timezone: str
    day: date
    subtractive: SubtractiveContext | None


async def _completion_on_day(
    session: AsyncSession,
    scope: _ResponseScope,
    *,
    lock: bool = False,
) -> GoalCompletion | None:
    """Load the canonical goal/day row, optionally locking it for adjustment.

    The service writes and the database constrains ``local_day``. Timestamp
    bounds remain the read predicate for compatibility with historical rows
    and domain tests created before that denormalized key existed.
    """
    start, end = day_bounds_in_tz(scope.user_timezone, scope.day)
    statement = select(GoalCompletion).where(
        GoalCompletion.goal_id == scope.goal_id,
        GoalCompletion.user_id == scope.user_id,
        GoalCompletion.timestamp >= start,
        GoalCompletion.timestamp < end,
    )
    if lock:
        statement = statement.with_for_update()
    result = await session.execute(statement)
    return result.scalar_one_or_none()


async def _habit_day_units(
    session: AsyncSession,
    habit_id: int,
    user_id: int,
    day: date,
) -> float:
    """Sum all tier rows into the authoritative habit total for ``day``."""
    result = await session.execute(
        select(func.coalesce(func.sum(GoalCompletion.completed_units), 0.0))
        .join(Goal, col(Goal.id) == col(GoalCompletion.goal_id))
        .where(
            Goal.habit_id == habit_id,
            GoalCompletion.user_id == user_id,
            GoalCompletion.local_day == day,
        )
    )
    return float(result.scalar_one())


async def _idempotent_already_logged_response(
    session: AsyncSession,
    scope: _ResponseScope,
) -> CheckInResult:
    """Build the ``already_logged_today`` response shape used by both fast + race paths."""
    streak = await compute_consecutive_streak(
        session,
        scope.goal_id,
        scope.user_id,
        scope.user_timezone,
        scope.subtractive,
    )
    return CheckInResult(
        streak=streak,
        milestones=[],
        reason_code="already_logged_today",
        day_units=await _habit_day_units(session, scope.habit_id, scope.user_id, scope.day),
    )


async def _subtractive_context_for_goal(
    session: AsyncSession, habit: Habit
) -> SubtractiveContext | None:
    """Build the subtractive-streak context for the habit, else ``None``.

    The parent habit arrives without eager relationships, so load its complete
    ladder explicitly and pass it to the same pure polarity helper used by the
    habit list. Looking only at the posted tier made partial direction flips
    report an additive check-in streak and a subtractive list streak.
    """
    result = await session.execute(
        select(Goal).where(Goal.habit_id == habit.id).order_by(col(Goal.id))
    )
    try:
        return subtractive_context_for_goals(result.scalars().all(), habit.start_date)
    except MultipleResultsFound as exc:
        logger.exception(
            "subtractive_check_in_duplicate_clear_goal",
            extra={"habit_id": habit.id, "user_id": habit.user_id},
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="duplicate_clear_tier_goals",
        ) from exc


def _held_response(
    current_user: int, goal_id: int, old_streak: int, day_units: float
) -> CheckInResult:
    """Return ``streak_held`` without inserting a row -- naturally idempotent on retry."""
    logger.info(
        "goal_completion_held",
        extra={"user_id": current_user, "goal_id": goal_id, "streak": old_streak},
    )
    return CheckInResult(
        streak=old_streak,
        milestones=[],
        reason_code="streak_held",
        day_units=day_units,
    )


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
        completed_units=max(0.0, job.completed_units)
        if job.explicit_units
        else job.completed_units,
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
    return CheckInResult(
        streak=job.new_streak,
        milestones=milestones,
        reason_code=reason,
        day_units=await _habit_day_units(session, job.habit_id, job.user_id, job.target_day),
    )


async def _adjust_existing_completion(
    session: AsyncSession,
    job: _CheckInJob,
    completion: GoalCompletion | None = None,
) -> CheckInResult:
    """Serialize and apply one explicit signed delta to an existing row."""
    scope = _ResponseScope(
        job.goal_id,
        job.habit_id,
        job.user_id,
        job.user_timezone,
        job.target_day,
        job.subtractive,
    )
    locked = completion or await _completion_on_day(session, scope, lock=True)
    if locked is None:
        # The only caller that can arrive here without a row lost an insert
        # race whose winner was rolled back/deleted. Retrying the normal insert
        # is safer than acknowledging an adjustment that changed nothing.
        return await _try_persist_or_idempotent(session, job)

    adjusted = col(GoalCompletion.completed_units) + job.completed_units
    result = await session.execute(
        update(GoalCompletion)
        .where(col(GoalCompletion.id) == cast("int", locked.id))
        .values(completed_units=case((adjusted < 0, 0.0), else_=adjusted))
        .returning(col(GoalCompletion.completed_units))
    )
    if result.scalar_one_or_none() is None:
        await session.rollback()
        return await _try_persist_or_idempotent(session, job)
    await session.commit()
    new_streak = await compute_consecutive_streak(
        session,
        job.goal_id,
        job.user_id,
        job.user_timezone,
        job.subtractive,
    )
    logger.info(
        "goal_completion_units_adjusted",
        extra={
            "user_id": job.user_id,
            "goal_id": job.goal_id,
            "streak": new_streak,
        },
    )
    return CheckInResult(
        streak=new_streak,
        milestones=[],
        reason_code="units_adjusted",
        day_units=await _habit_day_units(session, job.habit_id, job.user_id, job.target_day),
    )


async def _try_persist_or_idempotent(session: AsyncSession, job: _CheckInJob) -> CheckInResult:
    """Persist once; on an insert race, adjust explicit units or return the legacy no-op."""
    try:
        return await _persist_and_build_response(session, job)
    except IntegrityError:
        # Rollback before the follow-up SELECT in case the integrity error
        # surfaced from the outer commit() rather than the savepoint flush --
        # SQLAlchemy marks the session as ``PendingRollbackError`` until
        # rollback() is called and any subsequent query would otherwise raise.
        await session.rollback()
        if job.explicit_units:
            return await _adjust_existing_completion(session, job)
        return await _idempotent_already_logged_response(
            session,
            _ResponseScope(
                job.goal_id,
                job.habit_id,
                job.user_id,
                job.user_timezone,
                job.target_day,
                job.subtractive,
            ),
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
    subtractive = await _subtractive_context_for_goal(session, ctx.habit)
    return await _idempotent_already_logged_response(
        session,
        _ResponseScope(
            goal_id,
            cast("int", ctx.habit.id),
            ctx.user_id,
            ctx.user_timezone,
            today_in_tz(ctx.user_timezone),
            subtractive,
        ),
    )


async def _held_if_unscheduled(
    session: AsyncSession,
    ctx: CheckInContext,
    *,
    did_complete: bool,
    target_day: date,
    scope: _ResponseScope,
) -> CheckInResult | None:
    """Return the no-write response for an unscheduled miss, if applicable."""
    if did_complete or is_scheduled_on(ctx.habit.notification_days, target_day.strftime("%a")):
        return None
    old_streak = await compute_consecutive_streak(
        session, scope.goal_id, ctx.user_id, ctx.user_timezone, scope.subtractive
    )
    return _held_response(
        ctx.user_id,
        scope.goal_id,
        old_streak,
        await _habit_day_units(session, scope.habit_id, ctx.user_id, target_day),
    )


def _requested_units(goal_target: float, *, did_complete: bool, explicit: float | None) -> float:
    """Resolve a legacy target-sized log or preserve an explicit signed delta."""
    if explicit is not None:
        return explicit
    return goal_target if did_complete else 0.0


def _pending_units(requested_units: float, *, explicit_units: bool) -> float:
    """Model the row an insert would expose to the streak calculation."""
    return max(0.0, requested_units) if explicit_units else requested_units


async def record_goal_completion(
    session: AsyncSession,
    ctx: CheckInContext,
    *,
    did_complete: bool = True,
    completed_on: date | None = None,
    completed_units: float | None = None,
) -> CheckInResult:
    """Record a check-in for an already-owned goal and return streak + milestones.

    This is the single source of truth for both ``POST /goal_completions/`` and
    the journal accept flow (#818). An omitted ``completed_units`` is idempotent
    on (user, goal, day) and retains the original full-target behavior. An
    explicit signed value adjusts that day's canonical row, floors it at zero,
    and deliberately recomputes the streak: correcting a day below the additive
    completion threshold can reduce the returned streak. ``goal_id`` records
    tier provenance; ``day_units`` sums every tier row for the habit/day.

    The caller is responsible for ownership; ``ctx.goal`` and ``ctx.habit``
    must already be loaded.
    """
    # An already-owned, persisted goal always carries a PK.
    goal_id = cast("int", ctx.goal.id)
    target_day = _resolve_target_day(completed_on, ctx.user_timezone)
    subtractive = await _subtractive_context_for_goal(session, ctx.habit)
    habit_id = cast("int", ctx.habit.id)
    response_scope = _ResponseScope(
        goal_id,
        habit_id,
        ctx.user_id,
        ctx.user_timezone,
        target_day,
        subtractive,
    )
    existing = await _completion_on_day(session, response_scope, lock=completed_units is not None)

    if existing is not None and completed_units is None:
        return await _idempotent_already_logged_response(
            session,
            response_scope,
        )

    # Unscheduled miss holds the current streak without inserting — only the
    # pre-insert streak is needed, so compute it once here.
    held = await _held_if_unscheduled(
        session,
        ctx,
        did_complete=did_complete,
        target_day=target_day,
        scope=response_scope,
    )
    if held is not None:
        return held

    # Persist path: derive pre- and post-insert streak from ONE history read.
    requested_units = _requested_units(
        ctx.goal.target,
        did_complete=did_complete,
        explicit=completed_units,
    )
    job = _CheckInJob(
        goal_id=goal_id,
        habit_id=habit_id,
        completed_units=requested_units,
        explicit_units=completed_units is not None,
        user_id=ctx.user_id,
        user_timezone=ctx.user_timezone,
        did_complete=did_complete,
        old_streak=0,
        new_streak=0,
        target_day=target_day,
        timestamp=_completion_timestamp(completed_on, ctx.user_timezone),
        subtractive=subtractive,
    )
    if existing is not None:
        return await _adjust_existing_completion(session, job, existing)

    old_streak, new_streak = await compute_streak_before_and_after(
        session,
        StreakScope(goal_id, ctx.user_id, ctx.user_timezone, subtractive),
        PendingCompletion(
            target_day,
            _pending_units(
                requested_units,
                explicit_units=completed_units is not None,
            ),
        ),
    )
    job = replace(job, old_streak=old_streak, new_streak=new_streak)
    return await _try_persist_or_idempotent(session, job)
