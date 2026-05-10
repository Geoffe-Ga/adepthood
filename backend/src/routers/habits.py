"""Habit CRUD API endpoints backed by the database."""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from dependencies.ownership import log_ownership_denied, require_owned_habit
from domain.habit_stats import compute_habit_stats
from errors import conflict, forbidden, not_found
from load_options import HABIT_WITH_GOALS_AND_COMPLETIONS
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from routers.auth import get_current_user
from schemas import Page, PaginationParams, build_page
from schemas.habit import Habit as HabitSchema
from schemas.habit import HabitCreate, HabitWithGoals
from schemas.habit_stats import HabitStats
from schemas.pagination import paginate_query
from services.streaks import compute_habit_streak
from services.users import get_user_timezone

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/habits", tags=["habits"])

# Per-user cap on habit rows; surfaces as 409 ``habit_quota_exceeded``.
_MAX_HABITS_PER_USER = 100

# Default goals seeded for every newly-created habit. Three tiers (low / clear
# / stretch) so the habits feature is functional from the moment a habit
# exists -- without these, ``POST /goal_completions`` always 404'd because no
# goal endpoint ever wrote a row, and the editor's PUT /goals/{id} had nothing
# to update. The frontend's onboarding code builds the same shape locally; we
# now mirror it server-side so ids round-trip correctly.
_DEFAULT_GOAL_TIERS: tuple[tuple[str, str, float], ...] = (
    ("low", "Low", 1.0),
    ("clear", "Clear", 2.0),
    ("stretch", "Stretch", 3.0),
)


def _populate_streak(habit: Habit, current_user: int, user_timezone: str) -> None:
    """Set ``habit.streak`` from the goal completions loaded in memory."""
    completions = [c for g in habit.goals for c in g.completions if c.user_id == current_user]
    habit.streak = compute_habit_streak(completions, user_timezone)


def _filter_completions_to_caller(habit: Habit, current_user: int) -> None:
    """Drop any completions on this habit's goals that don't belong to the caller.

    Defense-in-depth that mirrors the existing per-row filter in
    ``_populate_streak`` and the stats endpoint -- under the current write
    paths every ``GoalCompletion.user_id`` matches the parent habit's
    ``user_id`` (the only writer is ``POST /goal_completions/`` and it
    sources the user from the JWT), but a manual data-repair row, a
    future shared-goal feature, or an accidental backfill could otherwise
    leak across tenants when the schema embeds completions on the goal
    response.  We mutate the in-memory relation rather than rebuild the
    object graph; SQLAlchemy treats this as a transient list edit and
    will not flush deletes because we never commit the session.

    .. WARNING::
        Do **not** call ``session.commit()`` after this function returns
        on the same request. Replacing ``goal.completions`` marks the
        ``GoalCompletion`` rows that were filtered out as orphaned (the
        relation has ``cascade="all, delete-orphan"`` semantics by
        default for a back-populated collection), so a commit would
        permanently delete the other user's rows from the DB -- a
        cross-tenant data-loss bug. The two callers
        (``list_habits`` / ``get_habit``) are pure read endpoints and
        already follow this rule; if a future caller needs both the
        filtered response *and* a write, swap this for a read-only
        projection (build the ``HabitWithGoals`` payload manually with
        a list comprehension) instead of mutating the ORM relation.
    """
    for goal in habit.goals:
        goal.completions = [c for c in goal.completions if c.user_id == current_user]


def _build_default_goals(habit_id: int, habit_name: str) -> list[Goal]:
    """Three-tier default goals for a newly-created habit."""
    return [
        Goal(
            habit_id=habit_id,
            title=f"{label} goal for {habit_name}",
            tier=tier,
            target=target,
            target_unit="units",
            frequency=1.0,
            frequency_unit="per_day",
            is_additive=True,
        )
        for tier, label, target in _DEFAULT_GOAL_TIERS
    ]


async def _ensure_under_quota(session: AsyncSession, current_user: int) -> None:
    """Raise 409 if the caller already owns the per-user habit cap."""
    count = await session.scalar(
        select(func.count()).select_from(Habit).where(Habit.user_id == current_user)
    )
    if (count or 0) >= _MAX_HABITS_PER_USER:
        raise conflict("habit_quota_exceeded")


async def _ensure_unique_name(session: AsyncSession, current_user: int, name: str) -> None:
    """Raise 409 if the caller already owns a habit with the same normalized name."""
    candidate_name = name.strip().lower()
    duplicate = await session.scalar(
        select(Habit.id).where(
            Habit.user_id == current_user,
            func.lower(func.trim(Habit.name)) == candidate_name,
        )
    )
    if duplicate is not None:
        raise conflict("duplicate_habit_name")


async def _persist_habit_with_default_goals(session: AsyncSession, habit: Habit) -> int:
    """Insert the habit + three default goals in a single savepoint."""
    try:
        async with session.begin_nested():
            session.add(habit)
            await session.flush()  # populate habit.id for the goals' FK
            if habit.id is None:
                msg = "session.flush() did not populate habit.id"
                raise RuntimeError(msg)
            for goal in _build_default_goals(habit.id, habit.name):
                session.add(goal)
            new_id = habit.id
        await session.commit()
    except IntegrityError as exc:
        # A concurrent request for the same (user_id, normalized name)
        # won the race.  The unique index keeps the duplicate out;
        # surface the same 409 the pre-check would have so callers
        # cannot tell the two paths apart.
        raise conflict("duplicate_habit_name") from exc
    return new_id


async def _refetch_with_goals(session: AsyncSession, habit_id: int) -> Habit:
    """Re-load a habit with eager goals to avoid greenlet lazy-load errors."""
    statement = select(Habit).where(Habit.id == habit_id).options(HABIT_WITH_GOALS_AND_COMPLETIONS)
    result = await session.execute(statement)
    refreshed = result.scalars().one_or_none()
    if refreshed is None:
        # Should be unreachable: habit was committed in the same session
        # one statement ago. Surface as a 500 with a stable detail rather
        # than a confusing 200/empty.
        msg = f"habit {habit_id} disappeared between commit and refetch"
        raise RuntimeError(msg)
    return refreshed


@router.post("/", response_model=HabitWithGoals)
async def create_habit(
    payload: HabitCreate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Habit:
    """Create a habit + three default goals; 409 over-quota or duplicate name."""
    await _ensure_under_quota(session, current_user)
    await _ensure_unique_name(session, current_user, payload.name)
    habit = Habit(user_id=current_user, **payload.model_dump())
    new_id = await _persist_habit_with_default_goals(session, habit)
    refreshed = await _refetch_with_goals(session, new_id)
    logger.info("habit_created", extra={"user_id": current_user, "habit_id": refreshed.id})
    return refreshed


@router.get("/", response_model=None)
async def list_habits(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    pagination: Annotated[PaginationParams, Depends()],
) -> Page[HabitWithGoals] | list[HabitWithGoals]:
    """Return habits sorted by ``sort_order``; paginated when ``?paginate=true``."""
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
        _filter_completions_to_caller(habit, current_user)
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
    """Return a single habit (with eager-loaded goals + completions) for the caller."""
    habit = await _get_habit_with_completions(habit_id, current_user, session)
    user_tz = await get_user_timezone(session, current_user)
    _populate_streak(habit, current_user, user_tz)
    _filter_completions_to_caller(habit, current_user)
    return habit


@router.put("/{habit_id}", response_model=HabitSchema)
async def update_habit(
    payload: HabitCreate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    habit: Annotated[Habit, Depends(require_owned_habit)],
) -> Habit:
    """Replace an existing habit's fields; 409 on rename collision."""
    for key, value in payload.model_dump().items():
        setattr(habit, key, value)
    session.add(habit)
    try:
        await session.commit()
    except IntegrityError as exc:
        # The unique index on (user_id, lower(trim(name))) catches a
        # rename that collides with another habit the user already owns.
        await session.rollback()
        raise conflict("duplicate_habit_name") from exc
    await session.refresh(habit)
    logger.info("habit_updated", extra={"user_id": current_user, "habit_id": habit.id})
    return habit


@router.delete("/{habit_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_habit(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    habit: Annotated[Habit, Depends(require_owned_habit)],
) -> Response:
    """Delete a habit and cascade goals + completions; logs the cascade post-commit."""
    habit_id = habit.id
    cascade_goal_count = await session.scalar(
        select(func.count()).select_from(Goal).where(Goal.habit_id == habit_id)
    )
    cascade_completion_count = await session.scalar(
        select(func.count())
        .select_from(GoalCompletion)
        .join(Goal, col(Goal.id) == col(GoalCompletion.goal_id))
        .where(Goal.habit_id == habit_id)
    )
    await session.delete(habit)
    await session.commit()
    logger.info(
        "habit_deleted",
        extra={
            "user_id": current_user,
            "habit_id": habit_id,
            "cascade_goals": cascade_goal_count or 0,
            "cascade_completions": cascade_completion_count or 0,
        },
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _get_habit_with_completions(
    habit_id: int, current_user: int, session: AsyncSession
) -> Habit:
    """Eager-load a habit with goals + completions enforcing the 404 / 403 split."""
    statement = select(Habit).where(Habit.id == habit_id).options(HABIT_WITH_GOALS_AND_COMPLETIONS)
    result = await session.execute(statement)
    habit = result.scalars().first()
    if habit is None:
        raise not_found("habit")
    if habit.user_id != current_user:
        log_ownership_denied("habit", habit_id, current_user)
        raise forbidden("forbidden")
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
