from __future__ import annotations

from itertools import count
from threading import Lock

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

from schemas import Goal, GoalGroup

router = APIRouter()
_goals_router = APIRouter(prefix="/v1/goals", tags=["goals"])
_habits_router = APIRouter(prefix="/v1/habits", tags=["goals"])

# In-memory storage
_goals: dict[int, Goal] = {}
_goal_id_counter = count(1)
_goal_id_lock = Lock()

_goal_groups: dict[int, GoalGroup] = {}
_group_id_counter = count(1)
_group_id_lock = Lock()


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

    @field_validator("target", "frequency")
    @classmethod
    def positive(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("must be positive")
        return v

    @field_validator("habit_id")
    @classmethod
    def habit_positive(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("habit_id must be positive")
        return v


class GoalUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    tier: str | None = None
    target: float | None = None
    target_unit: str | None = None
    frequency: float | None = None
    frequency_unit: str | None = None
    is_additive: bool | None = None

    @field_validator("target", "frequency")
    @classmethod
    def positive(cls, v: float | None) -> float | None:
        if v is not None and v <= 0:
            raise ValueError("must be positive")
        return v


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


@_goals_router.post("/", response_model=Goal, status_code=201)
def create_goal(payload: GoalCreate) -> Goal:
    with _goal_id_lock:
        goal_id = next(_goal_id_counter)
    goal = Goal(id=goal_id, **payload.model_dump())
    _goals[goal_id] = goal
    return goal


@_goals_router.get("/{goal_id}", response_model=Goal)
def get_goal(goal_id: int) -> Goal:
    goal = _goals.get(goal_id)
    if not goal:
        raise HTTPException(status_code=404, detail=f"Goal {goal_id} not found")
    return goal


@_goals_router.put("/{goal_id}", response_model=Goal)
def update_goal(goal_id: int, payload: GoalUpdate) -> Goal:
    goal = _goals.get(goal_id)
    if not goal:
        raise HTTPException(status_code=404, detail=f"Goal {goal_id} not found")
    update_data = payload.model_dump(exclude_unset=True)
    updated = goal.model_copy(update=update_data)
    _goals[goal_id] = updated
    return updated


@_goals_router.delete("/{goal_id}")
def delete_goal(goal_id: int) -> dict[str, bool]:
    if goal_id in _goals:
        del _goals[goal_id]
        return {"ok": True}
    raise HTTPException(status_code=404, detail=f"Goal {goal_id} not found")


@_goals_router.post("/groups", response_model=GoalGroup, status_code=201)
def create_goal_group(payload: GoalGroupCreate) -> GoalGroup:
    with _group_id_lock:
        group_id = next(_group_id_counter)
    group = GoalGroup(id=group_id, **payload.model_dump())
    _goal_groups[group_id] = group
    return group


@_goals_router.get("/groups/{group_id}", response_model=GoalGroup)
def get_goal_group(group_id: int) -> GoalGroup:
    group = _goal_groups.get(group_id)
    if not group:
        raise HTTPException(status_code=404, detail=f"Goal group {group_id} not found")
    return group


@_goals_router.put("/groups/{group_id}", response_model=GoalGroup)
def update_goal_group(group_id: int, payload: GoalGroupUpdate) -> GoalGroup:
    group = _goal_groups.get(group_id)
    if not group:
        raise HTTPException(status_code=404, detail=f"Goal group {group_id} not found")
    update_data = payload.model_dump(exclude_unset=True)
    updated = group.model_copy(update=update_data)
    _goal_groups[group_id] = updated
    return updated


@_goals_router.delete("/groups/{group_id}")
def delete_goal_group(group_id: int) -> dict[str, bool]:
    if group_id in _goal_groups:
        del _goal_groups[group_id]
        return {"ok": True}
    raise HTTPException(status_code=404, detail=f"Goal group {group_id} not found")


@_habits_router.get("/{habit_id}/goals", response_model=list[Goal])
def list_goals_for_habit(habit_id: int) -> list[Goal]:
    return [g for g in _goals.values() if g.habit_id == habit_id]


router.include_router(_goals_router)
router.include_router(_habits_router)
