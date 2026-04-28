"""Goal completion API endpoints backed by the database."""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from database import get_session
from domain.dates import day_bounds_in_tz, today_in_tz
from errors import forbidden, not_found
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from routers.auth import get_current_user
from schemas import CheckInResult
from services.streaks import check_milestones, compute_consecutive_streak, update_streak
from services.users import get_user_timezone

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/goal_completions", tags=["goals"])

# Streak milestones surfaced on check-in responses.  Kept as a module constant
# so both the router and future background jobs share the same thresholds.
_DEFAULT_THRESHOLDS = [1, 3, 7, 14, 30]


class GoalCompletionRequest(BaseModel):
    """Payload for recording a goal completion or miss."""

    goal_id: int
    did_complete: bool = True


async def _get_owned_goal(session: AsyncSession, goal_id: int, user_id: int) -> Goal:
    """Fetch a goal and verify ownership through its parent habit."""
    goal = await session.get(Goal, goal_id)
    if goal is None:
        raise not_found("goal")

    habit = await session.get(Habit, goal.habit_id)
    if habit is None:
        raise forbidden("not_owner")
    if habit.user_id != user_id:
        raise forbidden("not_owner")

    return goal


async def _already_logged_today(
    session: AsyncSession,
    goal_id: int,
    user_id: int,
    user_timezone: str,
) -> bool:
    """Return True if a completion already exists for this goal today (BUG-GOAL-004).

    "Today" is the user's local calendar day, not the server's UTC day.
    The previous implementation used UTC midnight, which let a user on
    the West Coast log a habit at 11:30 PM Pacific (07:30 UTC the *next*
    day), then log it again at 8:00 AM the same morning Pacific (15:00
    UTC) — both rows passed the ``timestamp >= UTC_today_start`` check
    against different UTC dates and the idempotency guarantee broke.

    The half-open ``[start, end)`` form preserves correctness across the
    DST jumps (a local day may be 23 or 25 hours).
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
    """Build the ``already_logged_today`` response shape.

    Reused by both the cheap pre-check fast path and the
    ``IntegrityError`` slow path (BUG-GOAL-001 race) so the client sees
    the same payload either way and the contract documented on
    :func:`create_goal_completion` does not split.
    """
    streak = await compute_consecutive_streak(session, goal_id, user_id, user_timezone)
    return CheckInResult(
        streak=streak,
        milestones=[],
        reason_code="already_logged_today",
    )


@router.post("/", response_model=CheckInResult)
async def create_goal_completion(
    payload: GoalCompletionRequest,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> CheckInResult:
    """Record a check-in and return updated streak and milestones.

    Idempotent: if a completion for the same goal/user/day already exists,
    returns the current streak with ``reason_code="already_logged_today"``
    instead of inserting a duplicate (BUG-HABITS-015 / BUG-GOAL-005).

    The pre-check is the fast path for the common retry / optimistic-UI
    case.  Two concurrent requests can both pass it; the unique-per-day
    index on ``goalcompletion`` then catches the loser via
    ``IntegrityError`` and the same idempotent response is returned —
    closes the BUG-GOAL-001 TOCTOU.
    """
    goal = await _get_owned_goal(session, payload.goal_id, current_user)

    if goal.id is None:
        msg = "Goal ID unexpectedly None after database fetch"
        raise RuntimeError(msg)

    # Resolve the user's timezone once per request -- streak math, the
    # idempotency check, and any future audit logging all need to see
    # the same calendar day boundary.
    user_tz = await get_user_timezone(session, current_user)

    # Run the cheap idempotency check (one ``SELECT id ... LIMIT 1``)
    # before the expensive streak query (full scan + bucketing) so a
    # duplicate request fails fast on the hot retry / optimistic-UI
    # path; the streak query then only runs in the branch that actually
    # needs it for the response payload.
    if await _already_logged_today(session, payload.goal_id, current_user, user_tz):
        return await _idempotent_already_logged_response(session, goal.id, current_user, user_tz)

    old_streak = await compute_consecutive_streak(session, goal.id, current_user, user_tz)

    completed_units = goal.target if payload.did_complete else 0
    completion = GoalCompletion(
        goal_id=payload.goal_id,
        user_id=current_user,
        completed_units=completed_units,
    )
    try:
        # ``begin_nested`` opens a SAVEPOINT so an ``IntegrityError`` from
        # the unique-per-day index rolls back only the failed insert.
        # The outer transaction stays active and the follow-up query in
        # ``_idempotent_already_logged_response`` runs on a healthy
        # session — without the SAVEPOINT, aiosqlite leaves the
        # connection in a partially-aborted state that breaks the next
        # ``await``.
        async with session.begin_nested():
            session.add(completion)
        await session.commit()
    except IntegrityError:
        # A concurrent request for the same (goal, user, day) won the
        # race and committed first.  The DB-level unique index keeps
        # the duplicate out; we surface the same idempotent response
        # the pre-check would have so the client cannot tell the two
        # paths apart (BUG-GOAL-001).
        return await _idempotent_already_logged_response(session, goal.id, current_user, user_tz)

    new_streak, reason = update_streak(old_streak, did_check_in=payload.did_complete)

    logger.info(
        "goal_completion_recorded",
        extra={
            "user_id": current_user,
            "goal_id": payload.goal_id,
            "did_complete": payload.did_complete,
            "streak": new_streak,
        },
    )

    return CheckInResult(
        streak=new_streak,
        milestones=check_milestones(new_streak, _DEFAULT_THRESHOLDS, old_streak),
        reason_code=reason,
    )
