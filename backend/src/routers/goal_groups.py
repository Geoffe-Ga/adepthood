"""GoalGroup CRUD API endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlmodel import select

from database import get_session
from errors import not_found
from models.goal_group import GoalGroup
from routers.auth import get_current_user
from schemas.goal_group import GoalGroupCreate, GoalGroupResponse

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


@router.get("/", response_model=list[GoalGroupResponse])
async def list_goal_groups(
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> list[GoalGroup]:
    """Return user's goal groups and all shared templates."""
    await ensure_seed_templates(session)
    statement = (
        select(GoalGroup)
        .where(
            (GoalGroup.user_id == current_user) | (GoalGroup.shared_template == True)  # noqa: E712
        )
        .options(selectinload(GoalGroup.goals))  # type: ignore[arg-type]
    )
    result = await session.execute(statement)
    return list(result.scalars().all())


@router.get("/{group_id}", response_model=GoalGroupResponse)
async def get_goal_group(
    group_id: int,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> GoalGroup:
    """Return a single goal group with its goals."""
    statement = (
        select(GoalGroup).where(GoalGroup.id == group_id).options(selectinload(GoalGroup.goals))  # type: ignore[arg-type]
    )
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
    statement = (
        select(GoalGroup).where(GoalGroup.id == group.id).options(selectinload(GoalGroup.goals))  # type: ignore[arg-type]
    )
    result = await session.execute(statement)
    return result.scalars().one()


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
    # Re-fetch with eager-loaded goals to avoid lazy-load greenlet errors
    statement = (
        select(GoalGroup).where(GoalGroup.id == group_id).options(selectinload(GoalGroup.goals))  # type: ignore[arg-type]
    )
    result = await session.execute(statement)
    return result.scalars().one()


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_goal_group(
    group_id: int,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> Response:
    """Delete a goal group. Unlinks goals but does not delete them."""
    statement = (
        select(GoalGroup).where(GoalGroup.id == group_id).options(selectinload(GoalGroup.goals))  # type: ignore[arg-type]
    )
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
    return Response(status_code=status.HTTP_204_NO_CONTENT)
