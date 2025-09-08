from __future__ import annotations

from itertools import count

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from schemas import Goal, GoalGroup

router = APIRouter(tags=["goals"])

# In-memory storage
_goals: list[Goal] = []
_goal_id_counter = count(1)

_goal_groups: list[GoalGroup] = []
_group_id_counter = count(1)


class GoalCreate(BaseModel):
    habit_id: int
    title: str
    description: str | None = None
    tier: str
    target: float
    target_unit: str
    frequency: float
    frequency_unit: str
    is_additive: bool = True


class GoalUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    tier: str | None = None
    target: float | None = None
    target_unit: str | None = None
    frequency: float | None = None
    frequency_unit: str | None = None
    is_additive: bool | None = None


class GoalGroupCreate(BaseModel):
    name: str
    icon: str | None = None
    description: str | None = None
    user_id: int | None = None
    shared_template: bool = False
    source: str | None = None


class GoalGroupUpdate(BaseModel):
    name: str | None = None
    icon: str | None = None
    description: str | None = None
    user_id: int | None = None
    shared_template: bool | None = None
    source: str | None = None


@router.post("/goals/", response_model=Goal)
def create_goal(payload: GoalCreate) -> Goal:
    goal = Goal(id=next(_goal_id_counter), **payload.model_dump())
    _goals.append(goal)
    return goal


@router.get("/goals/{goal_id}", response_model=Goal)
def get_goal(goal_id: int) -> Goal:
    for goal in _goals:
        if goal.id == goal_id:
            return goal
    raise HTTPException(status_code=404, detail="Goal not found")


@router.put("/goals/{goal_id}", response_model=Goal)
def update_goal(goal_id: int, payload: GoalUpdate) -> Goal:
    for idx, goal in enumerate(_goals):
        if goal.id == goal_id:
            update_data = payload.model_dump(exclude_unset=True)
            updated = goal.model_copy(update=update_data)
            _goals[idx] = updated
            return updated
    raise HTTPException(status_code=404, detail="Goal not found")


@router.delete("/goals/{goal_id}")
def delete_goal(goal_id: int) -> dict[str, bool]:
    for idx, goal in enumerate(_goals):
        if goal.id == goal_id:
            _goals.pop(idx)
            return {"ok": True}
    raise HTTPException(status_code=404, detail="Goal not found")


@router.post("/goal_groups/", response_model=GoalGroup)
def create_goal_group(payload: GoalGroupCreate) -> GoalGroup:
    group = GoalGroup(id=next(_group_id_counter), **payload.model_dump())
    _goal_groups.append(group)
    return group


@router.get("/goal_groups/{group_id}", response_model=GoalGroup)
def get_goal_group(group_id: int) -> GoalGroup:
    for group in _goal_groups:
        if group.id == group_id:
            return group
    raise HTTPException(status_code=404, detail="Goal group not found")


@router.put("/goal_groups/{group_id}", response_model=GoalGroup)
def update_goal_group(group_id: int, payload: GoalGroupUpdate) -> GoalGroup:
    for idx, group in enumerate(_goal_groups):
        if group.id == group_id:
            update_data = payload.model_dump(exclude_unset=True)
            updated = group.model_copy(update=update_data)
            _goal_groups[idx] = updated
            return updated
    raise HTTPException(status_code=404, detail="Goal group not found")


@router.delete("/goal_groups/{group_id}")
def delete_goal_group(group_id: int) -> dict[str, bool]:
    for idx, group in enumerate(_goal_groups):
        if group.id == group_id:
            _goal_groups.pop(idx)
            return {"ok": True}
    raise HTTPException(status_code=404, detail="Goal group not found")


@router.get("/habits/{habit_id}/goals", response_model=list[Goal])
def list_goals_for_habit(habit_id: int) -> list[Goal]:
    return [g for g in _goals if g.habit_id == habit_id]
