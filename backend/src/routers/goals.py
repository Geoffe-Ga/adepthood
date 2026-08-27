"""Per-goal CRUD API endpoints backed by the database.

The original API only mutated goals via the habits PUT endpoint, but
``HabitCreate`` does not include goal fields, so target / unit / frequency /
is_additive could not be edited from the client.  This router fills that
gap with a single ``PUT /goals/{goal_id}`` endpoint scoped to the parent
habit's owner.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from dependencies.ownership import require_owned_goal, resolve_owned_goal_group
from error_responses import build_router
from models.goal import Goal
from routers.auth import get_current_user
from schemas.goal import Goal as GoalSchema
from schemas.goal import GoalUpdate

logger = logging.getLogger(__name__)

router = build_router(prefix="/goals", tags=["goals"])


@router.put("/{goal_id}", response_model=GoalSchema)
async def update_goal(
    payload: GoalUpdate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    goal: Annotated[Goal, Depends(require_owned_goal)],
) -> Goal:
    """Update an existing goal's editable fields.

    ``habit_id`` is intentionally not part of ``GoalUpdate`` so the parent
    habit cannot be swapped via this endpoint -- a goal is bound to its
    habit for life.

    ``goal_group_id`` *is* editable, and it names a second object that
    ``require_owned_goal`` says nothing about: that dependency authorises the
    goal in the path, not the group in the body.  Without its own object-level
    check, a caller could file their goal under someone else's group and have
    the owner read it back.  So every non-null group is authorised here as a
    write target.  Shared templates are rejected too -- they are ownerless and
    world-readable, so a goal parked in one is published to every user.
    """
    if payload.goal_group_id is not None:
        await resolve_owned_goal_group(session, payload.goal_group_id, current_user)
    for key, value in payload.model_dump().items():
        setattr(goal, key, value)
    session.add(goal)
    await session.commit()
    await session.refresh(goal)
    logger.info("goal_updated", extra={"user_id": current_user, "goal_id": goal.id})
    return goal
