"""Habit CRUD API endpoints backed by the database."""

from __future__ import annotations

from datetime import date as date_type

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlmodel import select

from database import get_session
from errors import not_found
from models.goal import Goal
from models.habit import Habit
from routers.auth import get_current_user
from schemas.habit import Habit as HabitSchema
from schemas.habit import HabitCreate, HabitWithGoals
from schemas.habit_stats import HabitStats

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


_DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]


@router.get("/{habit_id}/stats", response_model=HabitStats)
async def get_habit_stats(
    habit_id: int,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> HabitStats:
    """Return aggregated statistics for a habit's goal completions."""
    statement = (
        select(Habit)
        .where(Habit.id == habit_id)
        .options(selectinload(Habit.goals).selectinload(Goal.completions))  # type: ignore[arg-type]
    )
    result = await session.execute(statement)
    habit = result.scalars().first()
    if habit is None or habit.user_id != current_user:
        raise not_found("habit")

    # Gather all completions for this user across all goals
    completions = [c for goal in habit.goals for c in goal.completions if c.user_id == current_user]

    if not completions:
        return HabitStats(
            day_labels=list(_DAY_LABELS),
            values=[0.0] * 7,
            completions_by_day=[0] * 7,
            longest_streak=0,
            current_streak=0,
            total_completions=0,
            completion_rate=0.0,
            completion_dates=[],
        )

    # Aggregate units per day-of-week and track unique calendar dates
    units_by_day = [0.0] * 7
    presence_by_day = [0] * 7
    days_with_completions: set[str] = set()

    for c in completions:
        day_idx = c.timestamp.weekday()
        # Convert Monday=0 to Sunday=0 format (JS getDay() convention)
        js_day_idx = (day_idx + 1) % 7
        units_by_day[js_day_idx] += c.completed_units
        presence_by_day[js_day_idx] = 1
        days_with_completions.add(c.timestamp.strftime("%Y-%m-%d"))

    # Sort unique dates for streak and rate calculations
    sorted_dates = sorted(days_with_completions)

    # Longest streak: max consecutive calendar days with completions
    longest_streak = 0
    current_run = 0
    prev_date: date_type | None = None
    for date_str in sorted_dates:
        d = date_type.fromisoformat(date_str)
        if prev_date is not None and (d - prev_date).days == 1:
            current_run += 1
        else:
            current_run = 1
        longest_streak = max(longest_streak, current_run)
        prev_date = d

    # Current streak: consecutive days ending at the most recent date
    current_streak = 0
    for i in range(len(sorted_dates) - 1, -1, -1):
        d = date_type.fromisoformat(sorted_dates[i])
        if i == len(sorted_dates) - 1:
            current_streak = 1
        else:
            next_d = date_type.fromisoformat(sorted_dates[i + 1])
            if (next_d - d).days == 1:
                current_streak += 1
            else:
                break

    # Completion rate: days-with-completions / span-of-days (inclusive)
    first_date = date_type.fromisoformat(sorted_dates[0])
    last_date = date_type.fromisoformat(sorted_dates[-1])
    span_days = (last_date - first_date).days + 1
    completion_rate = len(days_with_completions) / span_days if span_days > 0 else 0.0

    return HabitStats(
        day_labels=list(_DAY_LABELS),
        values=units_by_day,
        completions_by_day=presence_by_day,
        longest_streak=longest_streak,
        current_streak=current_streak,
        total_completions=len(completions),
        completion_rate=completion_rate,
        completion_dates=sorted_dates,
    )
