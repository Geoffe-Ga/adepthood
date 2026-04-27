"""Habit CRUD API endpoints backed by the database."""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from database import get_session
from domain.dates import get_user_timezone
from domain.habit_stats import compute_habit_stats
from errors import not_found
from load_options import HABIT_WITH_GOALS_AND_COMPLETIONS
from models.habit import Habit
from routers.auth import get_current_user
from schemas import Page, PaginationParams, build_page
from schemas.habit import Habit as HabitSchema
from schemas.habit import HabitCreate, HabitWithGoals
from schemas.habit_stats import HabitStats
from schemas.pagination import paginate_query
from services.streaks import compute_habit_streak

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/habits", tags=["habits"])


def _populate_streak(habit: Habit, current_user: int, user_timezone: str) -> None:
    """Set ``habit.streak`` from the goal completions loaded in memory.

    ``user_timezone`` keeps the in-memory streak in sync with
    ``compute_consecutive_streak`` (BUG-STREAK-002): both compute days
    using the same calendar so the value displayed in ``GET /habits``
    matches what ``POST /goal_completions`` returns.
    """
    completions = [c for g in habit.goals for c in g.completions if c.user_id == current_user]
    habit.streak = compute_habit_streak(completions, user_timezone)


@router.post("/", response_model=HabitSchema)
async def create_habit(
    payload: HabitCreate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Habit:
    """Create a habit for the authenticated user."""
    habit = Habit(user_id=current_user, **payload.model_dump())
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    logger.info("habit_created", extra={"user_id": current_user, "habit_id": habit.id})
    return habit


@router.get("/", response_model=None)
async def list_habits(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    pagination: Annotated[PaginationParams, Depends()],
) -> Page[HabitWithGoals] | list[HabitWithGoals]:
    """Return all habits for the authenticated user, sorted by sort_order.

    BUG-INFRA-013: returns ``Page[HabitWithGoals]`` when ``?paginate=true``
    is set; otherwise the legacy bare list is returned for one release while
    the frontend migrates to the envelope.
    """
    query = (
        select(Habit)
        .where(Habit.user_id == current_user)
        .options(HABIT_WITH_GOALS_AND_COMPLETIONS)
        .order_by(Habit.sort_order.asc())  # type: ignore[union-attr]
    )
    items, total = await paginate_query(session, query, pagination)
    user_tz = await get_user_timezone(session, current_user)
    for habit in items:
        _populate_streak(habit, current_user, user_tz)
    serialized = [HabitWithGoals.model_validate(h, from_attributes=True) for h in items]
    if pagination.paginate:
        return build_page(serialized, total, pagination)
    return serialized


@router.get("/{habit_id}", response_model=HabitWithGoals)
async def get_habit(
    habit_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Habit:
    """Return a single habit by id, scoped to the authenticated user."""
    statement = select(Habit).where(Habit.id == habit_id).options(HABIT_WITH_GOALS_AND_COMPLETIONS)
    result = await session.execute(statement)
    habit = result.scalars().first()
    if habit is None or habit.user_id != current_user:
        raise not_found("habit")
    user_tz = await get_user_timezone(session, current_user)
    _populate_streak(habit, current_user, user_tz)
    return habit


@router.put("/{habit_id}", response_model=HabitSchema)
async def update_habit(
    habit_id: int,
    payload: HabitCreate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
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
    logger.info("habit_updated", extra={"user_id": current_user, "habit_id": habit.id})
    return habit


@router.delete("/{habit_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_habit(
    habit_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Response:
    """Delete a habit. Returns 204 No Content on success."""
    habit = await session.get(Habit, habit_id)
    if habit is None or habit.user_id != current_user:
        raise not_found("habit")
    await session.delete(habit)
    await session.commit()
    logger.info("habit_deleted", extra={"user_id": current_user, "habit_id": habit_id})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _get_habit_with_completions(
    habit_id: int, current_user: int, session: AsyncSession
) -> Habit:
    """Load a habit with goals+completions, raising 404 if not owned."""
    statement = select(Habit).where(Habit.id == habit_id).options(HABIT_WITH_GOALS_AND_COMPLETIONS)
    result = await session.execute(statement)
    habit = result.scalars().first()
    if habit is None or habit.user_id != current_user:
        raise not_found("habit")
    return habit


@router.get("/{habit_id}/stats", response_model=HabitStats)
async def get_habit_stats(
    habit_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> HabitStats:
    """Return aggregated statistics for a habit's goal completions."""
    habit = await _get_habit_with_completions(habit_id, current_user, session)
    completions = [c for goal in habit.goals for c in goal.completions if c.user_id == current_user]
    user_tz = await get_user_timezone(session, current_user)
    return compute_habit_stats(completions, user_tz)
