"""Per-resource ownership dependencies enforcing the 404 → 403 split."""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from errors import forbidden, not_found
from models.goal import Goal
from models.goal_group import GoalGroup
from models.habit import Habit
from models.journal_entry import JournalEntry
from models.practice import Practice
from models.user_practice import UserPractice
from routers.auth import get_current_user

logger = logging.getLogger(__name__)


def log_ownership_denied(resource: str, resource_id: int, current_user: int) -> None:
    """Emit a WARNING audit row when a cross-tenant probe is denied."""
    logger.warning(
        "resource_access_denied",
        extra={
            "resource": resource,
            "resource_id": resource_id,
            "user_id": current_user,
        },
    )


async def require_owned_habit(
    habit_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Habit:
    """Resolve ``habit_id`` and verify the caller owns it."""
    habit = await session.get(Habit, habit_id)
    if habit is None:
        raise not_found("habit")
    if habit.user_id != current_user:
        log_ownership_denied("habit", habit_id, current_user)
        raise forbidden("forbidden")
    return habit


async def require_owned_goal(
    goal_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Goal:
    """Resolve ``goal_id`` and verify the caller owns the parent habit.

    Goal ownership rides on the parent habit's ``user_id`` -- the goal table
    itself has no ``user_id`` column.  We collapse "missing goal" and "not
    yours" into a single 404 to deny enumeration (BUG-T7 / PR #265).  The
    orphaned-FK branch (goal exists, parent habit gone) is a distinct
    integrity-violation signal so it gets its own audit row.
    """
    goal = await session.get(Goal, goal_id)
    if goal is None:
        raise not_found("goal")
    habit = await session.get(Habit, goal.habit_id)
    if habit is None:
        logger.warning(
            "orphaned_goal_fk",
            extra={"goal_id": goal_id, "habit_id": goal.habit_id, "user_id": current_user},
        )
        raise not_found("goal")
    if habit.user_id != current_user:
        log_ownership_denied("goal", goal_id, current_user)
        raise not_found("goal")
    return goal


async def require_owned_journal_entry(
    entry_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> JournalEntry:
    """Resolve ``entry_id`` and verify the caller owns it.

    BUG-JOURNAL-007: soft-deleted rows are treated as non-existent (404)
    so a user cannot GET or DELETE an entry they already deleted.
    BUG-JOURNAL-006: the ownership check uses the identity-map result from
    the primary-key lookup; a future refactor should push the ``user_id``
    filter into the WHERE clause, but the existing pattern is preserved here
    to avoid touching more files than Prompt 12B owns.
    """
    result = await session.execute(
        select(JournalEntry).where(
            JournalEntry.id == entry_id,
            col(JournalEntry.deleted_at).is_(None),  # BUG-JOURNAL-007
        )
    )
    entry = result.scalars().first()
    if entry is None:
        raise not_found("journal_entry")
    if entry.user_id != current_user:
        log_ownership_denied("journal_entry", entry_id, current_user)
        raise forbidden("forbidden")
    return entry


async def require_owned_user_practice(
    user_practice_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> UserPractice:
    """Resolve ``user_practice_id`` and verify the caller owns it."""
    user_practice = await session.get(UserPractice, user_practice_id)
    if user_practice is None:
        raise not_found("user_practice")
    if user_practice.user_id != current_user:
        log_ownership_denied("user_practice", user_practice_id, current_user)
        raise forbidden("forbidden")
    return user_practice


async def require_visible_goal_group(
    group_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> GoalGroup:
    """Resolve ``group_id`` for read access -- owner or shared template."""
    group = await session.get(GoalGroup, group_id)
    if group is None:
        raise not_found("goal_group")
    if group.shared_template:
        return group
    if group.user_id != current_user:
        raise forbidden("forbidden")
    return group


async def require_owned_goal_group(
    group_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> GoalGroup:
    """Resolve ``group_id`` for write access -- owner only."""
    group = await session.get(GoalGroup, group_id)
    if group is None:
        raise not_found("goal_group")
    if group.user_id != current_user:
        raise forbidden("forbidden")
    return group


async def require_visible_practice(
    practice_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Practice:
    """Resolve ``practice_id`` for read access -- approved or submitter only."""
    practice = await session.get(Practice, practice_id)
    if practice is None:
        raise not_found("practice")
    if practice.approved:
        return practice
    if practice.submitted_by_user_id != current_user:
        raise forbidden("forbidden")
    return practice
