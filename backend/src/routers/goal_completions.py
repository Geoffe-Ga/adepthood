"""Goal completion API endpoints backed by the database."""

from __future__ import annotations

from datetime import date
from typing import Annotated, Self

from fastapi import Depends
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from bounds import RowIdField
from database import get_session
from dependencies.ownership import resolve_owned_goal_and_habit
from dependencies.timezone import current_user_timezone
from error_responses import build_router
from routers.auth import get_current_user
from schemas import CheckInResult
from services.checkin import CheckInContext, record_goal_completion

router = build_router(prefix="/goal_completions", tags=["goals"])


class GoalCompletionRequest(BaseModel):
    """Payload for recording a goal completion or miss; rejects unknown fields."""

    model_config = ConfigDict(extra="forbid")

    goal_id: RowIdField
    did_complete: bool = True
    # Calendar day the check-in is for, in the user's timezone. Omit to log
    # today; supply a past ``YYYY-MM-DD`` to backfill a missed day. A future
    # date is rejected by the route.
    completed_on: date | None = None
    # ``None`` preserves the idempotent full-target behavior of clients that
    # predate signed unit logging. Explicit values are additive deltas.
    completed_units: float | None = Field(default=None, allow_inf_nan=False)

    @model_validator(mode="after")
    def _validate_explicit_units(self) -> Self:
        """Keep completion polarity and an explicit amount unambiguous."""
        if self.completed_units is None:
            return self
        if self.did_complete == (self.completed_units == 0):
            msg = (
                "completed_units must be non-zero when did_complete is true and zero "
                "when did_complete is false"
            )
            raise ValueError(msg)
        return self


@router.post("/", response_model=CheckInResult)
async def create_goal_completion(
    payload: GoalCompletionRequest,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> CheckInResult:
    """Record a check-in and return updated streak and milestones.

    Logs against today by default; ``payload.completed_on`` backfills a past
    calendar day (a future date is rejected). Amount-less requests are
    idempotent on the same (user, goal, day); explicit signed amounts accumulate
    into that row. The recording itself lives in ``services.checkin`` so the
    journal accept flow (#818) records through the identical path.
    """
    goal, habit = await resolve_owned_goal_and_habit(session, payload.goal_id, current_user)
    ctx = CheckInContext(goal=goal, habit=habit, user_id=current_user, user_timezone=user_tz)
    return await record_goal_completion(
        session,
        ctx,
        did_complete=payload.did_complete,
        completed_on=payload.completed_on,
        completed_units=payload.completed_units,
    )
