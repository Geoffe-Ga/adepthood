"""Per-resource ownership dependencies enforcing the 404 → 403 split."""

from __future__ import annotations

import logging
from typing import Annotated, cast

from fastapi import Depends
from sqlalchemy import ColumnElement
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped
from sqlmodel import and_, col, or_, select

from database import get_session
from dependencies.auth import get_current_user_model
from errors import forbidden, not_found
from models.goal import Goal
from models.goal_group import GoalGroup
from models.habit import Habit
from models.journal_entry import JournalEntry
from models.practice import Practice
from models.practice_session import PracticeSession
from models.user import User
from models.user_practice import UserPractice
from routers.auth import get_current_user

logger = logging.getLogger(__name__)


def visible_to_user(owner_col: Mapped[int | None], user_id: int) -> ColumnElement[bool]:
    """WHERE predicate matching system (``owner_user_id IS NULL``) or caller-owned rows.

    The shared read-visibility predicate for the personal-library resources
    (practice recipes + tags): the caller sees every system row plus their own.
    List endpoints use it directly; :func:`system_or_owned_clause` ANDs it with
    an id filter for the single-row lookup.  Pass ``col(Model.owner_user_id)``.
    """
    return or_(owner_col.is_(None), owner_col == user_id)


def system_or_owned_clause(
    id_col: Mapped[int | None],
    owner_col: Mapped[int | None],
    obj_id: int,
    user_id: int,
) -> ColumnElement[bool]:
    """WHERE clause for a system (``owner_user_id IS NULL``) or caller-owned row.

    The single-row variant of :func:`visible_to_user`: ANDs the visibility
    predicate with an id filter.  Pass the model's ``col(Model.id)`` /
    ``col(Model.owner_user_id)``.
    """
    return and_(id_col == obj_id, visible_to_user(owner_col, user_id))


def require_personal_row(owner_user_id: int | None, *, system_detail: str) -> None:
    """Reject mutation of a system (ownerless) row with a stable 403 detail.

    Shared by the recipe/tag mutation routes: a system row has
    ``owner_user_id IS NULL`` and may be read but not modified.
    """
    if owner_user_id is None:
        raise forbidden(system_detail)


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


async def resolve_owned_goal_and_habit(
    session: AsyncSession, goal_id: int, user_id: int
) -> tuple[Goal, Habit]:
    """Resolve ``goal_id`` to ``(goal, parent_habit)`` with enumeration-safe checks.

    Goal ownership rides on the parent habit's ``user_id`` -- the goal table
    itself has no ``user_id`` column.  We collapse "missing goal" and "not
    yours" into a single 404 to deny enumeration.  The orphaned-FK branch
    (goal exists, parent habit gone) is a distinct integrity-violation signal
    so it gets its own audit row, but is still surfaced as 404.  Callers that
    only need the goal (e.g. the goal-detail dependency) discard the habit.
    """
    goal = await session.get(Goal, goal_id)
    if goal is None:
        raise not_found("goal")
    habit = await session.get(Habit, goal.habit_id)
    if habit is None:
        logger.warning(
            "orphaned_goal_fk",
            extra={"goal_id": goal_id, "habit_id": goal.habit_id, "user_id": user_id},
        )
        raise not_found("goal")
    if habit.user_id != user_id:
        log_ownership_denied("goal", goal_id, user_id)
        raise not_found("goal")
    return goal, habit


async def require_owned_goal(
    goal_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Goal:
    """Resolve ``goal_id`` and verify the caller owns the parent habit.

    Delegates to :func:`resolve_owned_goal_and_habit` and returns just the
    goal; the parent-habit ownership rule and the enumeration-safe 404s live
    there so the goal-completions route and this dependency stay in lockstep.
    """
    goal, _habit = await resolve_owned_goal_and_habit(session, goal_id, current_user)
    return goal


async def require_owned_journal_entry(
    entry_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> JournalEntry:
    """Resolve ``entry_id`` and verify the caller owns it.

    BUG-JOURNAL-007: soft-deleted rows are treated as non-existent (404)
    so a user cannot GET or DELETE an entry they already deleted.
    Another user's entry is also collapsed to 404 (not 403) so GET/DELETE match
    PATCH's enumeration-safe contract — the cross-user probe is still audited.
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
        raise not_found("journal_entry")
    return entry


async def resolve_owned_user_practice(
    session: AsyncSession, user_practice_id: int, user_id: int
) -> UserPractice:
    """Resolve ``user_practice_id`` for write access -- owner only -- and audit denials.

    Callers that receive a user-practice id in a request *body* (rather than
    the path) reuse this directly, so the ownership rule lives in exactly one
    place regardless of where the id arrived from.
    """
    user_practice = await session.get(UserPractice, user_practice_id)
    if user_practice is None:
        raise not_found("user_practice")
    if user_practice.user_id != user_id:
        log_ownership_denied("user_practice", user_practice_id, user_id)
        raise forbidden("forbidden")
    return user_practice


async def require_owned_user_practice(
    user_practice_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> UserPractice:
    """Resolve ``user_practice_id`` and verify the caller owns it.

    Delegates to :func:`resolve_owned_user_practice`, which owns the rule and
    emits the ``resource_access_denied`` audit row on a cross-tenant probe,
    matching :func:`require_owned_habit`.
    """
    return await resolve_owned_user_practice(session, user_practice_id, current_user)


async def resolve_owned_practice_session(
    session: AsyncSession, practice_session_id: int, user_id: int
) -> PracticeSession:
    """Resolve ``practice_session_id`` for write access -- owner only -- and audit denials.

    Sessions carry ``user_id`` directly, so ownership is a single comparison.
    There is deliberately no ``require_``-style dependency wrapper: no route
    takes ``practice_session_id`` as a path parameter, so a wrapper would be
    dead code.  Body-carried ids call this directly.
    """
    practice_session = await session.get(PracticeSession, practice_session_id)
    if practice_session is None:
        raise not_found("practice_session")
    if practice_session.user_id != user_id:
        log_ownership_denied("practice_session", practice_session_id, user_id)
        raise forbidden("forbidden")
    return practice_session


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


async def resolve_owned_goal_group(session: AsyncSession, group_id: int, user_id: int) -> GoalGroup:
    """Resolve ``group_id`` for write access -- owner only -- and audit denials.

    Shared templates need no branch of their own: the CHECK constraint on
    ``goalgroup`` keeps them ownerless (``user_id IS NULL``), so they fail
    the ownership comparison and land on the same 403 as another user's
    private group.  Callers that receive a group id in a request *body*
    (rather than the path) reuse this directly, so the write rule lives in
    exactly one place.
    """
    group = await session.get(GoalGroup, group_id)
    if group is None:
        raise not_found("goal_group")
    if group.user_id != user_id:
        log_ownership_denied("goal_group", group_id, user_id)
        raise forbidden("forbidden")
    return group


async def require_manageable_goal_group(
    group_id: int,
    caller: Annotated[User, Depends(get_current_user_model)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> GoalGroup:
    """Resolve ``group_id`` for write access, routing by what kind of group it is.

    Two authorities, because goal groups are two different kinds of object:

    - A **private group** stays owner-only. An admin is deliberately *not*
      admitted here: adepthood's governing promise is that a user's own space is
      their own, and an operator override on private content would trade one
      violation for a larger one.
    - A **shared template** is ownerless by construction
      (``ck_goalgroup_shared_template_user_id`` keeps ``user_id IS NULL``
      biconditional with the flag), so the owner comparison can never match
      anybody. Before this dependency existed that meant *nothing could ever
      edit or delete one* -- not the creator, not an operator -- so a published
      template was permanently unmodifiable. Admin is that missing authority.

    The ordering matters: the template branch is checked first, because falling
    through to the owner comparison is exactly the dead end this fixes.
    """
    group = await session.get(GoalGroup, group_id)
    if group is None:
        raise not_found("goal_group")
    caller_id = cast("int", caller.id)
    if group.shared_template:
        if not caller.is_admin:
            log_ownership_denied("goal_group", group_id, caller_id)
            raise forbidden("admin_required")
        return group
    if group.user_id != caller_id:
        log_ownership_denied("goal_group", group_id, caller_id)
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
