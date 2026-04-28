"""Ownership-resolution dependencies — the canonical 404→403 split.

Per the BUG-T7 remediation (prompt ``07-normalize-idor-ordering``), every
``GET/PATCH/PUT/DELETE /resource/{id}`` route on a user-scoped resource MUST
go through one of these dependencies.  They share the same two-step contract:

1. Resolve the row by primary key.  Missing → 404 ``{resource}_not_found``.
2. Authorize against ``current_user``.  Cross-user → 403 ``forbidden``.

Splitting the two branches (rather than collapsing both to 404 like a few
legacy routes did) keeps the audit trail honest -- a 403 on someone else's
resource ID surfaces in security logs, and the policy is uniform across the
API so a future endpoint cannot quietly drift back to "404-on-not-mine".

We use one explicit dependency per resource (Option 2 from the prompt) rather
than a generic factory.  Per-resource deps are explicit, type-stable, and
require no ``inspect.Signature`` rewriting -- the prompt's ``max-quality-no-shortcuts``
requirement steers us here.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from errors import forbidden, not_found
from models.goal_group import GoalGroup
from models.habit import Habit
from models.journal_entry import JournalEntry
from models.practice import Practice
from models.user_practice import UserPractice
from routers.auth import get_current_user


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
        raise forbidden("forbidden")
    return habit


async def require_owned_journal_entry(
    entry_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> JournalEntry:
    """Resolve ``entry_id`` and verify the caller owns it."""
    entry = await session.get(JournalEntry, entry_id)
    if entry is None:
        raise not_found("journal_entry")
    if entry.user_id != current_user:
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
        raise forbidden("forbidden")
    return user_practice


async def require_visible_goal_group(
    group_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> GoalGroup:
    """Resolve ``group_id`` for read access — owner OR shared template.

    Shared templates (``shared_template=True``, ``user_id IS NULL``) are
    catalog content readable by every authenticated user.  Private groups
    are readable only by their owner.  Mutation routes use
    :func:`require_owned_goal_group`, which is strictly stricter.
    """
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
    """Resolve ``group_id`` for write access — owner only.

    Shared templates have no owner (``user_id IS NULL`` enforced by DB
    CHECK constraint), so non-admin clients can never mutate them through
    this surface.  Closes BUG-GOAL-006: any authenticated user used to be
    able to edit/delete shared templates because the prior check
    (``group.user_id is not None and group.user_id != current_user``)
    short-circuited to "owner-equivalent" when ``user_id`` was NULL.
    """
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
    """Resolve ``practice_id`` for read access — approved OR submitter.

    Closes BUG-PRACTICE-001: ``GET /practices/{id}`` previously returned
    pending submissions to anyone with the ID, leaking other users' draft
    practices.  Now an unapproved practice is visible only to the user
    who submitted it; everyone else gets 403.
    """
    practice = await session.get(Practice, practice_id)
    if practice is None:
        raise not_found("practice")
    if practice.approved:
        return practice
    if practice.submitted_by_user_id != current_user:
        raise forbidden("forbidden")
    return practice
