"""Goal completion API endpoints backed by the database."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from database import get_session
from dependencies.ownership import log_ownership_denied
from domain.dates import day_bounds_in_tz, today_in_tz
from domain.streaks import is_scheduled_on
from errors import bad_request, forbidden, not_found
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from routers.auth import get_current_user
from schemas import CheckInResult
from services.streaks import check_milestones, compute_consecutive_streak, update_streak
from services.users import get_user_timezone


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
    # Explicit completion time for a backfilled past day; ``None`` lets the
    # ``GoalCompletion`` model default (``datetime.now(UTC)``) stand.
    timestamp: datetime | None


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
) -> tuple[Goal, Habit, int]:
    """Fetch a goal + parent habit + the resolved goal id, verifying ownership."""
    goal = await session.get(Goal, goal_id)
    if goal is None:
        raise not_found("goal")
    resolved_id = goal.id
    if resolved_id is None:
        msg = "Goal ID unexpectedly None after database fetch"
        raise RuntimeError(msg)

    habit = await session.get(Habit, goal.habit_id)
    if habit is None:
        raise forbidden("not_owner")
    if habit.user_id != user_id:
        log_ownership_denied("goal", goal_id, user_id)
        raise forbidden("not_owner")

    return goal, habit, resolved_id


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
) -> CheckInResult:
    """Build the ``already_logged_today`` response shape used by both fast + race paths."""
    streak = await compute_consecutive_streak(session, goal_id, user_id, user_timezone)
    return CheckInResult(
        streak=streak,
        milestones=[],
        reason_code="already_logged_today",
    )


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
    """Persist + read streak/milestones inside one savepoint; reads streak post-flush."""
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
        new_streak = await compute_consecutive_streak(
            session, job.goal_id, job.user_id, job.user_timezone
        )
        _, reason = update_streak(
            job.old_streak,
            did_check_in=job.did_complete,
            is_scheduled_today=job.is_scheduled,
        )
        milestones = check_milestones(new_streak, _DEFAULT_THRESHOLDS, job.old_streak)
    await session.commit()
    logger.info(
        "goal_completion_recorded",
        extra={
            "user_id": job.user_id,
            "goal_id": job.goal_id,
            "did_complete": job.did_complete,
            "streak": new_streak,
        },
    )
    return CheckInResult(streak=new_streak, milestones=milestones, reason_code=reason)


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
            session, job.goal_id, job.user_id, job.user_timezone
        )


@router.post("/", response_model=CheckInResult)
async def create_goal_completion(
    payload: GoalCompletionRequest,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> CheckInResult:
    """Record a check-in and return updated streak and milestones.

    Logs against today by default; ``payload.completed_on`` backfills a
    past calendar day (a future date is rejected). Idempotent on the
    same (user, goal, day) -- the cheap day-pre-check runs before the
    expensive streak query so duplicate retries fail fast.
    """
    goal, habit, goal_id = await _get_owned_goal_and_habit(session, payload.goal_id, current_user)
    user_tz = await get_user_timezone(session, current_user)
    target_day = _resolve_target_day(payload.completed_on, user_tz)

    if await _already_logged_on(session, goal_id, current_user, user_tz, target_day):
        return await _idempotent_already_logged_response(session, goal_id, current_user, user_tz)

    is_scheduled = is_scheduled_on(habit.notification_days, target_day.strftime("%a"))
    # ``old_streak`` is also the held-path response value, so it has to
    # be read before the unscheduled-miss early return; the cheap
    # idempotency check above has already short-circuited duplicate
    # retries so only legitimate fresh requests pay the cost.
    old_streak = await compute_consecutive_streak(session, goal_id, current_user, user_tz)

    if not payload.did_complete and not is_scheduled:
        return _held_response(current_user, goal_id, old_streak)

    job = _CheckInJob(
        goal_id=goal_id,
        target=goal.target,
        user_id=current_user,
        user_timezone=user_tz,
        did_complete=payload.did_complete,
        is_scheduled=is_scheduled,
        old_streak=old_streak,
        timestamp=_completion_timestamp(payload.completed_on, user_tz),
    )
    return await _try_persist_or_idempotent(session, job)
