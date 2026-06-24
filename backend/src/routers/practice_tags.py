"""Practice-tag API -- personal tag library backing the recipe builder.

Five endpoints around :class:`models.practice_tag.PracticeTag`:

* ``GET /practice-tags`` -- visible to the caller (system + own).
* ``POST /practice-tags`` -- create a personal tag.
* ``GET /practice-tags/{tag_id}`` -- read one.
* ``PATCH /practice-tags/{tag_id}`` -- rename a personal tag (label only;
  slug is immutable so recipe steps that copied it stay valid).
* ``DELETE /practice-tags/{tag_id}`` -- delete a personal tag.

The visibility rule for read endpoints is identical to recipes: the
caller sees every system row plus every row whose ``owner_user_id``
matches their JWT subject.  Mutation routes additionally check that
``owner_user_id`` is set to the caller -- attempts to mutate a system
tag return ``403 cannot_modify_system_tag`` rather than 404 so the
client can render an informative message.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, or_, select

from database import get_session
from errors import conflict, forbidden, not_found
from models.practice_tag import PracticeTag
from routers.auth import get_current_user
from schemas import Page, PaginationParams, build_page
from schemas.pagination import paginate_query
from schemas.practice_tag import PracticeTagCreate, PracticeTagOut, PracticeTagUpdate

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/practice-tags", tags=["practice-tags"])


async def _load_visible_tag(tag_id: int, user_id: int, session: AsyncSession) -> PracticeTag:
    """Fetch a tag the caller is allowed to see, else raise 404."""
    result = await session.execute(
        select(PracticeTag).where(
            PracticeTag.id == tag_id,
            or_(
                col(PracticeTag.owner_user_id).is_(None),
                PracticeTag.owner_user_id == user_id,
            ),
        )
    )
    tag = result.scalar_one_or_none()
    if tag is None:
        raise not_found("practice_tag")
    return tag


def _require_personal(tag: PracticeTag) -> None:
    """Reject mutation of a system tag with a stable 403 detail."""
    if tag.owner_user_id is None:
        raise forbidden("cannot_modify_system_tag")


@router.get("/", response_model=None)
async def list_practice_tags(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    pagination: Annotated[PaginationParams, Depends()],
) -> Page[PracticeTagOut] | list[PracticeTagOut]:
    """List every tag the caller can see (system + own); paginated on ``?paginate=true``.

    Ordering stays system-first then label so the bare-list contract is
    unchanged; pagination slices that ordered set (issue #465).
    """
    query = (
        select(PracticeTag)
        .where(
            or_(
                col(PracticeTag.owner_user_id).is_(None),
                PracticeTag.owner_user_id == user_id,
            )
        )
        .order_by(col(PracticeTag.owner_user_id).nulls_first(), PracticeTag.label)
    )
    items, total = await paginate_query(session, query, pagination)
    serialized = [PracticeTagOut.model_validate(tag, from_attributes=True) for tag in items]
    if pagination.paginate:
        return build_page(serialized, total, pagination)
    return serialized


@router.post("/", response_model=PracticeTagOut, status_code=status.HTTP_201_CREATED)
async def create_practice_tag(
    payload: PracticeTagCreate,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PracticeTag:
    """Create a personal tag owned by the caller.

    Slug uniqueness is per-user (the partial index in migration
    ``07b8c9d0e1f2``).  A collision returns ``409 tag_slug_taken``
    rather than the bare 500 the IntegrityError would otherwise
    bubble up to.
    """
    tag = PracticeTag(slug=payload.slug, label=payload.label, owner_user_id=user_id)
    session.add(tag)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise conflict("tag_slug_taken") from exc
    await session.refresh(tag)
    logger.info(
        "practice_tag_created",
        extra={"tag_id": tag.id, "user_id": user_id, "slug": tag.slug},
    )
    return tag


@router.get("/{tag_id}", response_model=PracticeTagOut)
async def get_practice_tag(
    tag_id: int,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PracticeTag:
    """Read one tag visible to the caller."""
    return await _load_visible_tag(tag_id, user_id, session)


@router.patch("/{tag_id}", response_model=PracticeTagOut)
async def update_practice_tag(
    tag_id: int,
    payload: PracticeTagUpdate,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PracticeTag:
    """Rename a personal tag.  Slug is immutable; only ``label`` changes."""
    tag = await _load_visible_tag(tag_id, user_id, session)
    _require_personal(tag)
    tag.label = payload.label
    session.add(tag)
    await session.commit()
    await session.refresh(tag)
    return tag


@router.delete("/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_practice_tag(
    tag_id: int,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> None:
    """Delete a personal tag.

    Recipes that copied the slug stay intact -- recipe steps carry
    ``tag_slug`` by value, not by FK.
    """
    tag = await _load_visible_tag(tag_id, user_id, session)
    _require_personal(tag)
    await session.delete(tag)
    await session.commit()
    logger.info("practice_tag_deleted", extra={"tag_id": tag_id, "user_id": user_id})
