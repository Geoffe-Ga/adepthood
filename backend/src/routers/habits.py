"""Habit CRUD API endpoints."""

from __future__ import annotations

from itertools import count

from fastapi import APIRouter, HTTPException

from schemas.habit import Habit, HabitCreate

router = APIRouter(prefix="/habits", tags=["habits"])

_habits: list[Habit] = []
_id_counter = count(1)


@router.post("/", response_model=Habit)
def create_habit(payload: HabitCreate) -> Habit:
    """Create a habit and store it in memory."""
    habit = Habit(id=next(_id_counter), **payload.model_dump())
    _habits.append(habit)
    return habit


@router.get("/", response_model=list[Habit])
def list_habits() -> list[Habit]:
    """Return all habits sorted by their sort order."""
    return sorted(_habits, key=lambda h: (h.sort_order if h.sort_order is not None else h.id))


@router.get("/{habit_id}", response_model=Habit)
def get_habit(habit_id: int) -> Habit:
    """Return a single habit by id."""
    for habit in _habits:
        if habit.id == habit_id:
            return habit
    raise HTTPException(status_code=404, detail="Habit not found")


@router.put("/{habit_id}", response_model=Habit)
def update_habit(habit_id: int, payload: HabitCreate) -> Habit:
    """Replace an existing habit."""
    for index, habit in enumerate(_habits):
        if habit.id == habit_id:
            updated = Habit(id=habit_id, **payload.model_dump())
            _habits[index] = updated
            return updated
    raise HTTPException(status_code=404, detail="Habit not found")


@router.delete("/{habit_id}")
def delete_habit(habit_id: int) -> None:
    """Delete a habit from the in-memory store."""
    for index, habit in enumerate(_habits):
        if habit.id == habit_id:
            del _habits[index]
            return None
    raise HTTPException(status_code=404, detail="Habit not found")
