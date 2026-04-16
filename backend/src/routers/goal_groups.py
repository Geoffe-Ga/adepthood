"""GoalGroup CRUD API endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from database import get_session
from errors import not_found
from load_options import GOAL_GROUP_WITH_GOALS
from models.goal_group import GoalGroup
from routers.auth import get_current_user
from schemas import Page, PaginationParams, build_page
from schemas.goal_group import GoalGroupCreate, GoalGroupResponse
from schemas.pagination import paginate_query

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/goal-groups", tags=["goal-groups"])

SEED_TEMPLATES: list[dict[str, object]] = [
    {
        "name": "Meditation Goals",
        "icon": "🧘",
        "description": "Tiered meditation practice targets",
        "source": "built-in",
    },
    {
        "name": "Exercise Goals",
        "icon": "🏋️",
        "description": "Progressive exercise intensity targets",
        "source": "built-in",
    },
    {
        "name": "Nutrition Goals",
        "icon": "🥗",
        "description": "Balanced nutrition tracking targets",
        "source": "built-in",
    },
]


async def ensure_seed_templates(session: AsyncSession) -> None:
    """Create built-in shared templates if they don't already exist."""
    result = await session.execute(
        select(GoalGroup).where(
            GoalGroup.shared_template == True,  # noqa: E712
            GoalGroup.source == "built-in",
        )
    )
    existing = result.scalars().all()
    existing_names = {t.name for t in existing}
    for template in SEED_TEMPLATES:
        if template["name"] not in existing_names:
            session.add(GoalGroup(shared_template=True, user_id=None, **template))
    await session.commit()


@router.get("/", response_model=None)
async def list_goal_groups(
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
    pagination: PaginationParams = Depends(),  # noqa: B008
) -> Page[GoalGroupResponse] | list[GoalGroupResponse]:
    """Return user's goal groups and all shared templates.

    BUG-INFRA-015: returns ``Page[GoalGroupResponse]`` when ``?paginate=true``
    is set; otherwise the legacy bare list is returned for one release while
    the frontend migrates to the envelope.
    """
    await ensure_seed_templates(session)
    query = (
        select(GoalGroup)
        .where(
            (GoalGroup.user_id == current_user) | (GoalGroup.shared_template == True)  # noqa: E712
        )
        .options(GOAL_GROUP_WITH_GOALS)
    )
    items, total = await paginate_query(session, query, pagination)
    serialized = [GoalGroupResponse.model_validate(g, from_attributes=True) for g in items]
    if pagination.paginate:
        return build_page(serialized, total, pagination)
    return serialized


@router.get("/{group_id}", response_model=GoalGroupResponse)
async def get_goal_group(
    group_id: int,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> GoalGroup:
    """Return a single goal group with its goals."""
    statement = select(GoalGroup).where(GoalGroup.id == group_id).options(GOAL_GROUP_WITH_GOALS)
    result = await session.execute(statement)
    group = result.scalars().first()
    if group is None:
        raise not_found("goal_group")
    if group.user_id is not None and group.user_id != current_user:
        raise not_found("goal_group")
    return group


@router.post("/", response_model=GoalGroupResponse, status_code=status.HTTP_201_CREATED)
async def create_goal_group(
    payload: GoalGroupCreate,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> GoalGroup:
    """Create a new goal group for the authenticated user."""
    group = GoalGroup(
        user_id=current_user if not payload.shared_template else None,
        **payload.model_dump(),
    )
    session.add(group)
    await session.commit()
    # Re-fetch with eager-loaded goals to avoid lazy-load greenlet errors
    statement = select(GoalGroup).where(GoalGroup.id == group.id).options(GOAL_GROUP_WITH_GOALS)
    result = await session.execute(statement)
    refreshed = result.scalars().one()
    logger.info(
        "goal_group_created", extra={"user_id": current_user, "goal_group_id": refreshed.id}
    )
    return refreshed


async def _refetch_goal_group_with_goals(session: AsyncSession, group_id: int) -> GoalGroup:
    """Re-fetch a goal group with eager-loaded goals or raise 404.

    BUG-INFRA-020: uses ``.first()`` + None check rather than ``.one()`` so a
    concurrent delete surfaces as a 404 rather than ``NoResultFound``.
    """
    statement = select(GoalGroup).where(GoalGroup.id == group_id).options(GOAL_GROUP_WITH_GOALS)
    result = await session.execute(statement)
    refreshed = result.scalars().first()
    if refreshed is None:
        raise not_found("goal_group")
    return refreshed


@router.put("/{group_id}", response_model=GoalGroupResponse)
async def update_goal_group(
    group_id: int,
    payload: GoalGroupCreate,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> GoalGroup:
    """Update an existing goal group."""
    group = await session.get(GoalGroup, group_id)
    if group is None or (group.user_id is not None and group.user_id != current_user):
        raise not_found("goal_group")
    for key, value in payload.model_dump().items():
        setattr(group, key, value)
    session.add(group)
    await session.commit()
    refreshed = await _refetch_goal_group_with_goals(session, group_id)
    logger.info("goal_group_updated", extra={"user_id": current_user, "goal_group_id": group_id})
    return refreshed


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_goal_group(
    group_id: int,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> Response:
    """Delete a goal group. Unlinks goals but does not delete them."""
    statement = select(GoalGroup).where(GoalGroup.id == group_id).options(GOAL_GROUP_WITH_GOALS)
    result = await session.execute(statement)
    group = result.scalars().first()
    if group is None or (group.user_id is not None and group.user_id != current_user):
        raise not_found("goal_group")
    # Unlink goals from the group before deleting
    for goal in group.goals:
        goal.goal_group_id = None
        session.add(goal)
    await session.delete(group)
    await session.commit()
    logger.info("goal_group_deleted", extra={"user_id": current_user, "goal_group_id": group_id})
    return Response(status_code=status.HTTP_204_NO_CONTENT)
