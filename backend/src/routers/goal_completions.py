"""Goal completion API endpoints backed by the database."""

from __future__ import annotations

import logging
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from dependencies.ownership import log_ownership_denied
from dependencies.timezone import current_user_timezone
from errors import not_found
from models.goal import Goal
from models.habit import Habit
from routers.auth import get_current_user
from schemas import CheckInResult
from services.checkin import CheckInContext, record_goal_completion

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/goal_completions", tags=["goals"])


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


@router.post("/", response_model=CheckInResult)
async def create_goal_completion(
    payload: GoalCompletionRequest,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> CheckInResult:
    """Record a check-in and return updated streak and milestones.

    Logs against today by default; ``payload.completed_on`` backfills a past
    calendar day (a future date is rejected). Idempotent on the same
    (user, goal, day). The recording itself lives in ``services.checkin`` so the
    journal accept flow (#818) records through the identical path.
    """
    goal, habit = await _get_owned_goal_and_habit(session, payload.goal_id, current_user)
    ctx = CheckInContext(goal=goal, habit=habit, user_id=current_user, user_timezone=user_tz)
    return await record_goal_completion(
        session,
        ctx,
        did_complete=payload.did_complete,
        completed_on=payload.completed_on,
    )
