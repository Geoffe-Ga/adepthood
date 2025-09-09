"""Goal and goal group CRUD endpoints."""

from __future__ import annotations

from itertools import count

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel

from schemas.goal import Goal
from schemas.goal_group import GoalGroup, GoalGroupCreate

router = APIRouter(prefix="/v1", tags=["goals"])

_goals: dict[int, Goal] = {}
_goal_groups: dict[int, GoalGroup] = {}
_goal_id_counter = count(1)
_group_id_counter = count(1)


class GoalCreate(BaseModel):
    """Payload for creating or updating a goal."""

    habit_id: int
    title: str
    description: str | None = None
    tier: str
    target: float
    target_unit: str
    frequency: float
    frequency_unit: str
    is_additive: bool = True
    goal_group_id: int | None = None


@router.post("/goal-groups", response_model=GoalGroup, status_code=status.HTTP_201_CREATED)
def create_goal_group(payload: GoalGroupCreate) -> GoalGroup:
    group_id = next(_group_id_counter)
    group = GoalGroup(id=group_id, **payload.model_dump())
    _goal_groups[group_id] = group
    return group


@router.get("/goal-groups", response_model=list[GoalGroup])
def list_goal_groups() -> list[GoalGroup]:
    return list(_goal_groups.values())


@router.get("/goal-groups/{group_id}", response_model=GoalGroup)
def get_goal_group(group_id: int) -> GoalGroup:
    group = _goal_groups.get(group_id)
    if group is None:
        raise HTTPException(status_code=404, detail=f"goal_group {group_id} not found")
    return group


@router.put("/goal-groups/{group_id}", response_model=GoalGroup)
def update_goal_group(group_id: int, payload: GoalGroupCreate) -> GoalGroup:
    if group_id not in _goal_groups:
        raise HTTPException(status_code=404, detail=f"goal_group {group_id} not found")
    group = GoalGroup(id=group_id, **payload.model_dump())
    _goal_groups[group_id] = group
    return group


@router.delete("/goal-groups/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_goal_group(group_id: int) -> Response:
    if group_id not in _goal_groups:
        raise HTTPException(status_code=404, detail=f"goal_group {group_id} not found")
    del _goal_groups[group_id]
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/goals", response_model=Goal, status_code=status.HTTP_201_CREATED)
def create_goal(payload: GoalCreate) -> Goal:
    goal_id = next(_goal_id_counter)
    goal = Goal(id=goal_id, **payload.model_dump())
    _goals[goal_id] = goal
    return goal


@router.get("/goals", response_model=list[Goal])
def list_goals() -> list[Goal]:
    return list(_goals.values())


@router.get("/goals/{goal_id}", response_model=Goal)
def get_goal(goal_id: int) -> Goal:
    goal = _goals.get(goal_id)
    if goal is None:
        raise HTTPException(status_code=404, detail=f"goal {goal_id} not found")
    return goal


@router.put("/goals/{goal_id}", response_model=Goal)
def update_goal(goal_id: int, payload: GoalCreate) -> Goal:
    if goal_id not in _goals:
        raise HTTPException(status_code=404, detail=f"goal {goal_id} not found")
    goal = Goal(id=goal_id, **payload.model_dump())
    _goals[goal_id] = goal
    return goal


@router.delete("/goals/{goal_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_goal(goal_id: int) -> Response:
    if goal_id not in _goals:
        raise HTTPException(status_code=404, detail=f"goal {goal_id} not found")
    del _goals[goal_id]
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/habits/{habit_id}/goals", response_model=list[Goal])
def list_goals_for_habit(habit_id: int) -> list[Goal]:
    return [g for g in _goals.values() if g.habit_id == habit_id]
