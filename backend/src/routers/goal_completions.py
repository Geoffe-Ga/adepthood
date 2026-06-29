"""Goal completion API endpoints backed by the database."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy.exc import IntegrityError, MultipleResultsFound
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from dependencies.ownership import log_ownership_denied
from dependencies.timezone import current_user_timezone
from domain.dates import day_bounds_in_tz, today_in_tz
from domain.streaks import is_scheduled_on
from errors import bad_request, not_found
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from routers.auth import get_current_user
from schemas import CheckInResult
from services.streaks import (
    PendingCompletion,
    StreakScope,
    SubtractiveContext,
    check_milestones,
    compute_consecutive_streak,
    compute_streak_before_and_after,
    update_streak,
)


@dataclass(frozen=True)
class _CheckInJob:
    """Inputs to ``_persist_and_build_response`` / ``_try_persist_or_idempotent``."""

    goal_id: int
    target: float
    user_id: int
    user_timezone: str
    did_complete: bool
    is_scheduled: bool
    old_streak: int
    new_streak: int
    # Explicit completion time for a backfilled past day; ``None`` lets the
    # ``GoalCompletion`` model default (``datetime.now(UTC)``) stand.
    timestamp: datetime | None
    # Subtractive-habit context for the streak computation: a no-log day
    # on an "abstain from sugar" habit is success, not a chain break.
    # ``None`` selects the additive code path.
    subtractive: SubtractiveContext | None


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/goal_completions", tags=["goals"])

_DEFAULT_THRESHOLDS = [1, 3, 7, 14, 30]

# A completion may be backfilled at most this many days into the past.
# Beyond this window a user could manufacture an arbitrarily long streak
# by logging one consecutive past day at a time.
_MAX_BACKFILL_DAYS = 30


class GoalCompletionRequest(BaseModel):
    """Payload for recording a goal completion or miss; rejects unknown fields."""

    model_config = ConfigDict(extra="forbid")

    goal_id: int
    did_complete: bool = True
    # Calendar day the check-in is for, in the user's timezone. Omit to log
    # today; supply a past ``YYYY-MM-DD`` to backfill a missed day. A future
    # date is rejected by the route.
    completed_on: date | None = None


async def _get_owned_goal_and_habit(
    session: AsyncSession, goal_id: int, user_id: int
) -> tuple[Goal, Habit]:
    """Fetch a goal + parent habit, verifying ownership."""
    goal = await session.get(Goal, goal_id)
    if goal is None:
        raise not_found("goal")

    habit = await session.get(Habit, goal.habit_id)
    if habit is None:
        # Orphaned FK (goal exists, parent habit gone) — a distinct integrity
        # signal, but collapsed to 404 like a missing goal so it never acts as
        # an enumeration oracle (matches dependencies.ownership.require_owned_goal).
        logger.warning(
            "orphaned_goal_fk",
            extra={"goal_id": goal_id, "habit_id": goal.habit_id, "user_id": user_id},
        )
        raise not_found("goal")
    if habit.user_id != user_id:
        # Cross-tenant access is collapsed to 404 (not 403) so a prober cannot
        # tell "exists but not yours" from "absent" — the enumeration-safe
        # contract the goals router already enforces.
        log_ownership_denied("goal", goal_id, user_id)
        raise not_found("goal")

    return goal, habit


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

    The check-in payload identifies a single goal (any tier), but the
    "transgression" line the user thinks in terms of is always the
    clear-tier sibling.  ``None`` selects the additive code path so
    additive habits behave exactly as before.

    Queries the sibling directly rather than walking ``habit.goals``
    because the habit row is fetched with ``session.get`` (no eager
    relationship load), and touching the lazy-loaded relationship in an
    async context raises ``MissingGreenlet``.

    Filters on ``is_additive == False`` to mirror the in-memory
    ``_subtractive_context`` helper in ``routers/habits.py``: if a
    mixed-polarity fixture or partial migration ever co-locates an
    additive clear goal under the same habit, this filter rejects it
    before it builds a wrong-shape context.

    Uses ``scalar_one_or_none`` rather than ``scalar`` so duplicate
    ``clear``-tier siblings (no DB-level ``UniqueConstraint`` on
    ``(habit_id, tier)`` today -- PR #379 review) surface as a
    ``MultipleResultsFound``, which is re-raised as a stable 500
    so clients see a predictable error code instead of an opaque
    server error.
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

    Defaults to the user's today when ``completed_on`` is omitted. Rejects
    a future date, and a backfill older than ``_MAX_BACKFILL_DAYS`` days.
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
    unambiguously inside that local calendar day regardless of DST
    shoulder days, and buckets on it under the unique-per-day index.
    """
    if completed_on is None:
        return None
    start, end = day_bounds_in_tz(user_timezone, completed_on)
    return start + (end - start) / 2


async def _persist_and_build_response(session: AsyncSession, job: _CheckInJob) -> CheckInResult:
    """Persist the completion and build a CheckInResult; streak values arrive pre-computed."""
    completion = GoalCompletion(
        goal_id=job.goal_id,
        user_id=job.user_id,
        completed_units=job.target if job.did_complete else 0,
    )
    if job.timestamp is not None:
        completion.timestamp = job.timestamp
    async with session.begin_nested():
        session.add(completion)
        await session.flush()
    await session.commit()
    # ``new_streak`` was computed alongside ``old_streak`` from one history read
    # (issue dedup); these are pure derivations, no DB recompute.
    _, reason = update_streak(
        job.old_streak,
        did_check_in=job.did_complete,
        is_scheduled_today=job.is_scheduled,
    )
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
        # surfaced from the outer commit() rather than the savepoint flush
        # -- SQLAlchemy marks the session as ``PendingRollbackError`` until
        # rollback() is called and any subsequent query would otherwise
        # raise on a clean-looking happy path.
        await session.rollback()
        return await _idempotent_already_logged_response(
            session,
            job.goal_id,
            job.user_id,
            job.user_timezone,
            job.subtractive,
        )


@router.post("/", response_model=CheckInResult)
async def create_goal_completion(
    payload: GoalCompletionRequest,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> CheckInResult:
    """Record a check-in and return updated streak and milestones.

    Logs against today by default; ``payload.completed_on`` backfills a
    past calendar day (a future date is rejected). Idempotent on the
    same (user, goal, day) -- the cheap day-pre-check runs before the
    expensive streak query so duplicate retries fail fast.
    """
    goal, habit = await _get_owned_goal_and_habit(session, payload.goal_id, current_user)
    goal_id = payload.goal_id
    target_day = _resolve_target_day(payload.completed_on, user_tz)
    subtractive = await _subtractive_context_for_goal(session, habit, goal)

    if await _already_logged_on(session, goal_id, current_user, user_tz, target_day):
        return await _idempotent_already_logged_response(
            session, goal_id, current_user, user_tz, subtractive
        )

    is_scheduled = is_scheduled_on(habit.notification_days, target_day.strftime("%a"))

    # Unscheduled miss holds the current streak without inserting — only the
    # pre-insert streak is needed, so compute it once here.
    if not payload.did_complete and not is_scheduled:
        old_streak = await compute_consecutive_streak(
            session, goal_id, current_user, user_tz, subtractive
        )
        return _held_response(current_user, goal_id, old_streak)

    # Persist path: derive the pre- and post-insert streak from ONE history
    # read instead of recomputing on each branch (the day is fresh — the
    # idempotency check above ruled out an existing log for it).
    pending_units = goal.target if payload.did_complete else 0.0
    old_streak, new_streak = await compute_streak_before_and_after(
        session,
        StreakScope(goal_id, current_user, user_tz, subtractive),
        PendingCompletion(target_day, pending_units),
    )

    job = _CheckInJob(
        goal_id=goal_id,
        target=goal.target,
        user_id=current_user,
        user_timezone=user_tz,
        did_complete=payload.did_complete,
        is_scheduled=is_scheduled,
        old_streak=old_streak,
        new_streak=new_streak,
        timestamp=_completion_timestamp(payload.completed_on, user_tz),
        subtractive=subtractive,
    )
    return await _try_persist_or_idempotent(session, job)
