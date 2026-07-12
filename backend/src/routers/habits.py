"""Habit CRUD API endpoints backed by the database."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import CursorResult, delete, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from dependencies.ownership import log_ownership_denied, require_owned_habit
from dependencies.timezone import current_user_timezone
from domain.habit_stats import compute_habit_stats
from errors import conflict, forbidden, not_found
from load_options import HABIT_WITH_GOALS_AND_COMPLETIONS, habit_with_recent_completions
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from routers.auth import get_current_user
from schemas import Page, PaginationParams, build_page
from schemas.goal import Goal as GoalSchema
from schemas.goal import GoalUnitsUpdate
from schemas.habit import Habit as HabitSchema
from schemas.habit import HabitCreate, HabitWithGoals
from schemas.habit_stats import HabitStats
from schemas.pagination import paginate_query
from services.streaks import SubtractiveContext, compute_habit_streak

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/habits", tags=["habits"])

# Per-user cap on habit rows; surfaces as 409 ``habit_quota_exceeded``.
_MAX_HABITS_PER_USER = 100

# Rolling transport window for embedded completions (issue #294).  90 days
# matches the longest stage window in the APTITUDE program; rows older than
# this stay in the DB (and in the stats endpoint's all-time aggregates) but
# are trimmed from the habit GETs so payloads stop growing with account age.
# Streaks are NOT bounded by this window — ``_populate_streaks_for`` reads
# the full history via its own slim query.
_COMPLETIONS_WINDOW_DAYS = 90


def _recent_completions_cutoff() -> datetime:
    """The oldest completion timestamp the habit GETs will embed."""
    return datetime.now(UTC) - timedelta(days=_COMPLETIONS_WINDOW_DAYS)


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


def _subtractive_context(habit: Habit) -> SubtractiveContext | None:
    """Return the streak context for a subtractive habit, else ``None``.

    ``None`` selects the additive code path in :func:`compute_habit_streak`.

    Polarity is decided by a single rule shared with the frontend
    (``HabitUtils.getGoalTier``): a habit is subtractive iff **any** of its
    goals is non-additive. Probing one specific tier let the backend and the UI
    disagree when the tiers were not perfectly consistent — the backend took the
    additive path and a never-logged abstention habit reported a ``0`` streak
    while the badge said "Achieved" (BUG #768). The clear threshold comes from
    the ``clear``-tier goal's target; if that tier is absent it falls back to the
    first non-additive goal's target so a subtractive habit never silently
    returns ``None`` and mis-counts down the additive path.
    """
    non_additive = [g for g in habit.goals if not g.is_additive]
    if not non_additive:
        return None
    threshold = _subtractive_threshold(habit, non_additive[0])
    return SubtractiveContext(clear_threshold=threshold, start_date=habit.start_date)


def _subtractive_threshold(habit: Habit, fallback: Goal) -> float:
    """Abstention threshold for a subtractive streak.

    The ``clear``-tier goal's target is the ceiling; if that tier is absent the
    first non-additive goal (``fallback``) stands in so the streak still
    computes rather than mis-counting down the additive path.
    """
    clear = next((g for g in habit.goals if g.tier == "clear"), None)
    return clear.target if clear is not None else fallback.target


def _populate_streak(habit: Habit, completions: list[GoalCompletion], user_timezone: str) -> None:
    """Set ``habit.streak`` from the FULL completion history (issue #294).

    Deliberately not computed from the embedded (transport-windowed)
    rows: the streak is the program's primary motivational KPI, and a
    chain longer than the window would silently clip. Callers fetch the
    history via :func:`_streak_completions_by_habit` — server-side only,
    so the response payload stays bounded.
    """
    habit.streak = compute_habit_streak(completions, user_timezone, _subtractive_context(habit))


async def _populate_streaks_for(
    session: AsyncSession, habits: list[Habit], current_user: int, user_tz: str
) -> None:
    """Set streaks for a page of habits from ONE full-history query (issue #294)."""
    history = await _streak_completions_by_habit(
        session, [h.id for h in habits if h.id is not None], current_user
    )
    for habit in habits:
        _populate_streak(habit, history.get(habit.id or -1, []), user_tz)


async def _streak_completions_by_habit(
    session: AsyncSession, habit_ids: list[int], user_id: int
) -> dict[int, list[GoalCompletion]]:
    """Full-history completions grouped by habit, for streak math only."""
    if not habit_ids:
        return {}
    result = await session.execute(
        select(Goal.habit_id, GoalCompletion)
        .join(Goal, col(GoalCompletion.goal_id) == col(Goal.id))
        .where(col(Goal.habit_id).in_(habit_ids), GoalCompletion.user_id == user_id)
    )
    by_habit: dict[int, list[GoalCompletion]] = {habit_id: [] for habit_id in habit_ids}
    for habit_id, completion in result.all():
        by_habit[habit_id].append(completion)
    return by_habit


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


async def _refetch_with_goals(session: AsyncSession, habit_id: int, current_user: int) -> Habit:
    """Re-load a habit with eager goals to avoid greenlet lazy-load errors."""
    statement = (
        select(Habit)
        .where(Habit.id == habit_id)
        .options(habit_with_recent_completions(_recent_completions_cutoff(), current_user))
        .execution_options(populate_existing=True)
    )
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
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> Habit:
    """Create a habit + three default goals; 409 over-quota or duplicate name."""
    await _ensure_under_quota(session, current_user)
    await _ensure_unique_name(session, current_user, payload.name)
    habit = Habit(user_id=current_user, **payload.model_dump())
    new_id = await _persist_habit_with_default_goals(session, habit)
    refreshed = await _refetch_with_goals(session, new_id, current_user)
    # Recompute the streak like the list/detail paths so POST mirrors GET instead
    # of returning the model default (0); a subtractive habit can already have a
    # non-zero abstention streak from its start_date with no completions (#768).
    await _populate_streaks_for(session, [refreshed], current_user, user_tz)
    logger.info("habit_created", extra={"user_id": current_user, "habit_id": refreshed.id})
    return refreshed


@router.get("/", response_model=None)
async def list_habits(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    pagination: Annotated[PaginationParams, Depends()],
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> Page[HabitWithGoals] | list[HabitWithGoals]:
    """Return habits sorted by ``sort_order``; paginated when ``?paginate=true``."""
    # Eager-load goals + completions; dropping this triggers MissingGreenlet downstream.
    query = (
        select(Habit)
        .where(Habit.user_id == current_user)
        .options(habit_with_recent_completions(_recent_completions_cutoff(), current_user))
        # See _get_habit_with_completions: keep the windowed view authoritative
        # even when an unwindowed loader ran earlier on this session.
        .execution_options(populate_existing=True)
        .order_by(Habit.sort_order.asc())  # type: ignore[union-attr]
    )
    items, total = await paginate_query(session, query, pagination)
    await _populate_streaks_for(session, items, current_user, user_tz)
    serialized = [HabitWithGoals.model_validate(h, from_attributes=True) for h in items]
    if pagination.paginate:
        return build_page(serialized, total, pagination)
    return serialized


@router.get("/{habit_id}", response_model=HabitWithGoals)
async def get_habit(
    habit_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> Habit:
    """Return a single habit (with eager-loaded goals + completions) for the caller."""
    habit = await _get_habit_with_completions(habit_id, current_user, session)
    await _populate_streaks_for(session, [habit], current_user, user_tz)
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
    """Delete a habit and cascade its goals + completions via the FK cascade."""
    habit_id = habit.id
    await session.delete(habit)
    await session.commit()
    logger.info(
        "habit_deleted",
        extra={
            "user_id": current_user,
            "habit_id": habit_id,
        },
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/{habit_id}/completions", status_code=status.HTTP_204_NO_CONTENT)
async def clear_habit_completions(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    habit: Annotated[Habit, Depends(require_owned_habit)],
) -> Response:
    """Bulk-delete every goal-completion row for the owned habit's goals.

    Resets the habit's completion history in one statement so a start-date
    reset (or any other "start fresh" flow) leaves no stale rows behind for a
    later refetch to embed. Ownership is enforced by ``require_owned_habit``,
    yielding the same 404 (missing) / 403 (cross-user) split as
    :func:`delete_habit`. A defense-in-depth ``user_id`` filter guarantees only
    the caller's own rows are removed even if a foreign row is somehow parented
    to one of the habit's goals.
    """
    # ``execute`` is typed ``Result``; a DELETE yields a ``CursorResult`` whose
    # ``rowcount`` is the number of rows removed.
    result = cast(
        "CursorResult[Any]",
        await session.execute(
            delete(GoalCompletion).where(
                col(GoalCompletion.goal_id).in_(
                    select(col(Goal.id)).where(Goal.habit_id == habit.id)
                ),
                col(GoalCompletion.user_id) == current_user,
            )
        ),
    )
    await session.commit()
    logger.info(
        "habit_completions_cleared",
        extra={
            "user_id": current_user,
            "habit_id": habit.id,
            "deleted_count": result.rowcount,
        },
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _get_habit_with_completions(
    habit_id: int, current_user: int, session: AsyncSession, *, windowed: bool = True
) -> Habit:
    """Eager-load a habit with goals + completions enforcing the 404 / 403 split.

    ``windowed=True`` (the habit GETs) trims embedded completions to the
    rolling transport window (issue #294); ``windowed=False`` keeps the
    full history for all-time consumers like the stats endpoint.
    """
    loader = (
        habit_with_recent_completions(_recent_completions_cutoff(), current_user)
        if windowed
        else HABIT_WITH_GOALS_AND_COMPLETIONS
    )
    # ``populate_existing``: the windowed and full loaders disagree about
    # what ``goal.completions`` holds, and SQLAlchemy will not re-populate
    # an already-loaded collection on the same session.  Without this, the
    # first loader to run would silently win for every later call sharing
    # the session (issue #294).
    statement = (
        select(Habit)
        .where(Habit.id == habit_id)
        .options(loader)
        .execution_options(populate_existing=True)
    )
    result = await session.execute(statement)
    habit = result.scalars().first()
    if habit is None:
        raise not_found("habit")
    if habit.user_id != current_user:
        log_ownership_denied("habit", habit_id, current_user)
        raise forbidden("forbidden")
    return habit


@router.put("/{habit_id}/goals/units", response_model=list[GoalSchema])
async def update_goal_units(
    payload: GoalUnitsUpdate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    habit: Annotated[Habit, Depends(require_owned_habit)],
) -> list[Goal]:
    """Update the shared unit fields on every goal of the habit atomically.

    Issue #289: the GoalUnitEditor previously fanned out one
    ``PUT /goals/{id}`` per tier, so a mid-sequence failure left tiers
    with mismatched units server-side.  A single transaction here makes
    the all-tiers invariant atomic: either every goal moves to the new
    unit fields or none do.  Tier identity and per-tier targets are
    deliberately untouched.
    """
    result = await session.execute(select(Goal).where(Goal.habit_id == habit.id))
    goals = list(result.scalars().all())
    for goal in goals:
        goal.target_unit = payload.target_unit
        goal.frequency = payload.frequency
        goal.frequency_unit = payload.frequency_unit
        session.add(goal)
    await session.commit()
    for goal in goals:
        await session.refresh(goal)
    logger.info(
        "goal_units_updated",
        extra={"user_id": current_user, "habit_id": habit.id, "goal_count": len(goals)},
    )
    return goals


@router.get("/{habit_id}/stats", response_model=HabitStats)
async def get_habit_stats(
    habit_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> HabitStats:
    """Return aggregated statistics for a habit's goal completions."""
    # All-time aggregates: deliberately NOT windowed (issue #294).
    habit = await _get_habit_with_completions(habit_id, current_user, session, windowed=False)
    completions = [c for goal in habit.goals for c in goal.completions if c.user_id == current_user]
    return compute_habit_stats(completions, user_tz, _subtractive_context(habit))
