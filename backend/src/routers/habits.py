"""Habit CRUD API endpoints backed by the database."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlmodel import select

from database import get_session
from errors import not_found
from models.habit import Habit
from routers.auth import get_current_user
from schemas.habit import Habit as HabitSchema
from schemas.habit import HabitCreate, HabitWithGoals

router = APIRouter(prefix="/habits", tags=["habits"])


@router.post("/", response_model=HabitSchema)
async def create_habit(
    payload: HabitCreate,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> Habit:
    """Create a habit for the authenticated user."""
    habit = Habit(user_id=current_user, **payload.model_dump())
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    return habit


@router.get("/", response_model=list[HabitWithGoals])
async def list_habits(
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> list[Habit]:
    """Return all habits for the authenticated user, sorted by sort_order."""
    statement = (
        select(Habit)
        .where(Habit.user_id == current_user)
        .options(selectinload(Habit.goals))  # type: ignore[arg-type]
        .order_by(Habit.sort_order.asc())  # type: ignore[union-attr]
    )
    result = await session.execute(statement)
    return list(result.scalars().all())


@router.get("/{habit_id}", response_model=HabitWithGoals)
async def get_habit(
    habit_id: int,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> Habit:
    """Return a single habit by id, scoped to the authenticated user."""
    statement = (
        select(Habit).where(Habit.id == habit_id).options(selectinload(Habit.goals))  # type: ignore[arg-type]
    )
    result = await session.execute(statement)
    habit = result.scalars().first()
    if habit is None or habit.user_id != current_user:
        raise not_found("habit")
    return habit


@router.put("/{habit_id}", response_model=HabitSchema)
async def update_habit(
    habit_id: int,
    payload: HabitCreate,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> Habit:
    """Replace an existing habit's fields."""
    habit = await session.get(Habit, habit_id)
    if habit is None or habit.user_id != current_user:
        raise not_found("habit")
    for key, value in payload.model_dump().items():
        setattr(habit, key, value)
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    return habit


@router.delete("/{habit_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_habit(
    habit_id: int,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> Response:
    """Delete a habit. Returns 204 No Content on success."""
    habit = await session.get(Habit, habit_id)
    if habit is None or habit.user_id != current_user:
        raise not_found("habit")
    await session.delete(habit)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
