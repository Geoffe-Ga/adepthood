"""Goal completion API endpoints backed by the database."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from database import get_session
from domain.dates import day_bounds_in_tz, today_in_tz
from domain.streaks import is_scheduled_on
from errors import forbidden, not_found
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
    is_scheduled_today: bool
    old_streak: int


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/goal_completions", tags=["goals"])

_DEFAULT_THRESHOLDS = [1, 3, 7, 14, 30]


class GoalCompletionRequest(BaseModel):
    """Payload for recording a goal completion or miss; rejects unknown fields."""

    model_config = ConfigDict(extra="forbid")

    goal_id: int
    did_complete: bool = True


async def _get_owned_goal_and_habit(
    session: AsyncSession, goal_id: int, user_id: int
) -> tuple[Goal, Habit]:
    """Fetch a goal + its parent habit, verifying ownership."""
    goal = await session.get(Goal, goal_id)
    if goal is None:
        raise not_found("goal")

    habit = await session.get(Habit, goal.habit_id)
    if habit is None:
        raise forbidden("not_owner")
    if habit.user_id != user_id:
        raise forbidden("not_owner")

    return goal, habit


async def _already_logged_today(
    session: AsyncSession,
    goal_id: int,
    user_id: int,
    user_timezone: str,
) -> bool:
    """Return True if a completion already exists for this goal today.

    "Today" is the user's local calendar day (not server UTC) so the
    boundary ticks over at the user's midnight; the half-open
    ``[start, end)`` form preserves correctness across DST jumps.
    """
    today = today_in_tz(user_timezone)
    start, end = day_bounds_in_tz(user_timezone, today)
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


async def _persist_and_build_response(session: AsyncSession, job: _CheckInJob) -> CheckInResult:
    """Persist + compute streak/milestones inside one savepoint so failures roll back atomically.

    Streak is re-read after the flush so the response matches what
    subsequent GETs will see; ``update_streak`` is consulted only for
    its reason code.
    """
    completion = GoalCompletion(
        goal_id=job.goal_id,
        user_id=job.user_id,
        completed_units=job.target if job.did_complete else 0,
    )
    async with session.begin_nested():
        session.add(completion)
        await session.flush()
        new_streak = await compute_consecutive_streak(
            session, job.goal_id, job.user_id, job.user_timezone
        )
        _, reason = update_streak(
            job.old_streak,
            did_check_in=job.did_complete,
            is_scheduled_today=job.is_scheduled_today,
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

    Idempotent on the same (user, goal, day): the pre-check fast path
    or the unique-per-day index slow path both surface the same
    ``already_logged_today`` envelope.

    The cheap idempotency check (single ``SELECT id ... LIMIT 1``)
    runs before the expensive streak query so a duplicate retry fails
    fast on the hot optimistic-UI path.
    """
    goal, habit = await _get_owned_goal_and_habit(session, payload.goal_id, current_user)
    if goal.id is None:
        msg = "Goal ID unexpectedly None after database fetch"
        raise RuntimeError(msg)
    user_tz = await get_user_timezone(session, current_user)

    if await _already_logged_today(session, payload.goal_id, current_user, user_tz):
        return await _idempotent_already_logged_response(session, goal.id, current_user, user_tz)

    today_weekday = today_in_tz(user_tz).strftime("%a")
    is_scheduled_today = is_scheduled_on(habit.notification_days, today_weekday)
    # ``old_streak`` is also the response value for the unscheduled-miss
    # held path below, so the query has to run before that branch even
    # though no row is written; the cheap idempotency check above has
    # already short-circuited the duplicate-retry case.
    old_streak = await compute_consecutive_streak(session, goal.id, current_user, user_tz)

    if not payload.did_complete and not is_scheduled_today:
        return _held_response(current_user, goal.id, old_streak)

    job = _CheckInJob(
        goal_id=goal.id,
        target=goal.target,
        user_id=current_user,
        user_timezone=user_tz,
        did_complete=payload.did_complete,
        is_scheduled_today=is_scheduled_today,
        old_streak=old_streak,
    )
    return await _try_persist_or_idempotent(session, job)
