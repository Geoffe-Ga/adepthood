from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from domain.milestones import achieved_milestones
from domain.streaks import update_streak
from schemas import CheckInResult, Milestone

router = APIRouter(prefix="/goal_completions", tags=["goals"])


class GoalCompletionRequest(BaseModel):
    """Payload for recording a goal completion or miss."""

    goal_id: int
    did_complete: bool = True


@dataclass
class GoalState:
    """In-memory goal state used for demo purposes."""

    streak: int
    thresholds: list[int]


# simple in-memory store of goal progress and milestone thresholds
_goal_state: dict[int, GoalState] = {1: GoalState(streak=0, thresholds=[1, 3])}


@router.post("/", response_model=CheckInResult)
def create_goal_completion(payload: GoalCompletionRequest) -> CheckInResult:
    """Update streak and return any achieved milestones for a goal."""
    state = _goal_state.get(payload.goal_id)
    if state is None:
        raise HTTPException(status_code=404, detail="goal_not_found")

    new_streak, reason = update_streak(state.streak, payload.did_complete)
    state.streak = new_streak

    reached, _ = achieved_milestones(new_streak, state.thresholds)
    milestones = [Milestone(threshold=t) for t in reached]

    return CheckInResult(streak=new_streak, milestones=milestones, reason_code=reason)
