"""Course content API — drip-fed content with read-tracking."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from domain.course import compute_days_elapsed, filter_content_for_user, next_unlock_day
from domain.stage_progress import get_user_progress, stage_exists
from errors import not_found
from models.content_completion import ContentCompletion
from models.course_stage import CourseStage
from models.stage_content import StageContent
from routers.auth import get_current_user
from schemas.course import (
    ContentCompletionResponse,
    ContentItemResponse,
    CourseProgressResponse,
)

router = APIRouter(prefix="/course", tags=["course"])


async def _get_stage_by_number(session: AsyncSession, stage_number: int) -> CourseStage:
    """Fetch a CourseStage by number or raise 404."""
    result = await session.execute(
        select(CourseStage).where(CourseStage.stage_number == stage_number)
    )
    stage = result.scalars().first()
    if stage is None:
        raise not_found("stage")
    return stage


async def _days_for_user_stage(session: AsyncSession, user_id: int, stage_number: int) -> int:
    """Compute how many days the user has been on the given stage."""
    progress = await get_user_progress(session, user_id)
    if progress is None or progress.current_stage != stage_number:
        return -1  # User is not on this stage
    return compute_days_elapsed(progress.stage_started_at)


async def _read_ids_for_user(
    session: AsyncSession, user_id: int, content_ids: list[int]
) -> set[int]:
    """Return set of content_ids that the user has already read."""
    if not content_ids:
        return set()
    result = await session.execute(
        select(ContentCompletion.content_id).where(
            ContentCompletion.user_id == user_id,
            col(ContentCompletion.content_id).in_(content_ids),
        )
    )
    return set(result.scalars().all())


@router.get("/stages/{stage_number}/content", response_model=list[ContentItemResponse])
async def list_stage_content(
    stage_number: int,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> list[ContentItemResponse]:
    """List content for a stage with drip-feed gating applied."""
    stage = await _get_stage_by_number(session, stage_number)

    result = await session.execute(
        select(StageContent)
        .where(StageContent.course_stage_id == stage.id)
        .order_by(col(StageContent.release_day).asc())
    )
    items = result.scalars().all()

    days = await _days_for_user_stage(session, current_user, stage_number)
    # If user is not on this stage, treat as day -1 (everything locked)
    if days < 0:
        days = -1

    content_ids = [item.id for item in items if item.id is not None]
    read_ids = await _read_ids_for_user(session, current_user, content_ids)

    raw = [
        {
            "id": item.id,
            "title": item.title,
            "content_type": item.content_type,
            "release_day": item.release_day,
            "url": item.url,
        }
        for item in items
        if item.id is not None
    ]

    filtered = filter_content_for_user(raw, days_elapsed=days, read_content_ids=read_ids)
    return [ContentItemResponse(**f) for f in filtered]


@router.get("/content/{content_id}", response_model=ContentItemResponse)
async def get_content_item(
    content_id: int,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> ContentItemResponse:
    """Get a single content item with lock/read status."""
    result = await session.execute(select(StageContent).where(StageContent.id == content_id))
    item = result.scalars().first()
    if item is None:
        raise not_found("content")

    # Find which stage this content belongs to
    stage_result = await session.execute(
        select(CourseStage).where(CourseStage.id == item.course_stage_id)
    )
    stage = stage_result.scalars().first()
    if stage is None:
        raise not_found("stage")

    days = await _days_for_user_stage(session, current_user, stage.stage_number)
    if days < 0:
        days = -1

    item_id = item.id
    assert item_id is not None  # guaranteed after DB fetch
    read_ids = await _read_ids_for_user(session, current_user, [item_id])

    raw = [
        {
            "id": item_id,
            "title": item.title,
            "content_type": item.content_type,
            "release_day": item.release_day,
            "url": item.url,
        }
    ]
    filtered = filter_content_for_user(raw, days_elapsed=days, read_content_ids=read_ids)
    return ContentItemResponse(**filtered[0])


@router.post("/content/{content_id}/mark-read", response_model=ContentCompletionResponse)
async def mark_content_read(
    content_id: int,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> ContentCompletionResponse:
    """Mark a content item as read. Idempotent — repeated calls return existing record."""
    # Verify content exists
    result = await session.execute(select(StageContent).where(StageContent.id == content_id))
    if result.scalars().first() is None:
        raise not_found("content")

    # Check for existing completion (idempotent)
    existing_result = await session.execute(
        select(ContentCompletion).where(
            ContentCompletion.user_id == current_user,
            ContentCompletion.content_id == content_id,
        )
    )
    existing = existing_result.scalars().first()
    if existing is not None:
        return ContentCompletionResponse(
            id=existing.id,
            user_id=existing.user_id,
            content_id=existing.content_id,
            completed_at=existing.completed_at,
        )

    completion = ContentCompletion(user_id=current_user, content_id=content_id)
    session.add(completion)
    await session.commit()
    await session.refresh(completion)
    return ContentCompletionResponse(
        id=completion.id,
        user_id=completion.user_id,
        content_id=completion.content_id,
        completed_at=completion.completed_at,
    )


@router.get("/stages/{stage_number}/progress", response_model=CourseProgressResponse)
async def get_course_progress(
    stage_number: int,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> CourseProgressResponse:
    """Get read-progress for a stage's content."""
    if not await stage_exists(session, stage_number):
        raise not_found("stage")

    stage = await _get_stage_by_number(session, stage_number)

    result = await session.execute(
        select(StageContent).where(StageContent.course_stage_id == stage.id)
    )
    items = result.scalars().all()
    total = len(items)

    if total == 0:
        return CourseProgressResponse(
            total_items=0,
            read_items=0,
            progress_percent=0.0,
            next_unlock_day=None,
        )

    content_ids = [item.id for item in items if item.id is not None]
    read_ids = await _read_ids_for_user(session, current_user, content_ids)
    read_count = len(read_ids)

    progress_pct = round((read_count / total) * 100, 2)

    days = await _days_for_user_stage(session, current_user, stage_number)
    if days < 0:
        days = -1

    release_days = [item.release_day for item in items]
    next_day = next_unlock_day(release_days=release_days, days_elapsed=days)

    return CourseProgressResponse(
        total_items=total,
        read_items=read_count,
        progress_percent=progress_pct,
        next_unlock_day=next_day,
    )
