"""Course content API — drip-fed content with read-tracking."""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from domain.course import compute_days_elapsed, filter_content_for_user, next_unlock_day
from domain.stage_progress import get_user_progress, is_stage_unlocked, stage_exists
from errors import forbidden, not_found
from models.content_completion import ContentCompletion
from models.course_stage import CourseStage
from models.stage_content import StageContent
from routers.auth import get_current_user
from schemas import Page, PaginationParams, build_page
from schemas.course import (
    ContentCompletionResponse,
    ContentItemResponse,
    CourseProgressResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/course", tags=["course"])

# When a user is past a stage, all drip-feed content should be accessible.
# We use a large sentinel so ``release_day > days_elapsed`` is always False.
_PAST_STAGE_DAYS_SENTINEL = 999_999


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
    """Compute how many days the user has been on the given stage.

    Returns:
    - ``_PAST_STAGE_DAYS_SENTINEL`` when the user has already moved past
      this stage (all content should be unlocked).
    - The actual days elapsed when the user is currently on this stage.
    - ``-1`` when the user has no progress or hasn't reached this stage.
    """
    progress = await get_user_progress(session, user_id)
    if progress is None:
        return -1
    if progress.current_stage > stage_number:
        return _PAST_STAGE_DAYS_SENTINEL
    if progress.current_stage == stage_number:
        return compute_days_elapsed(progress.stage_started_at)
    return -1


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


def _items_to_raw_dicts(items: list[StageContent]) -> list[dict[str, object]]:
    """Convert StageContent rows to plain dicts for the filter function."""
    return [
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


async def _check_stage_unlocked(session: AsyncSession, user_id: int, stage_number: int) -> None:
    """Raise 403 if the given stage is locked for the user.

    Used by endpoints that take ``stage_number`` directly (1..36 are
    public knowledge), so the 403 carries no enumeration risk.
    """
    progress = await get_user_progress(session, user_id)
    if not is_stage_unlocked(stage_number, progress):
        raise forbidden("stage_locked")


async def _is_stage_unlocked_for_user(
    session: AsyncSession, user_id: int, stage_number: int
) -> bool:
    """Predicate form of :func:`_check_stage_unlocked`.

    Used on ``content_id``-keyed endpoints (BUG-COURSE-004): callers mask
    the locked branch as 404 to remove the existence oracle, rather than
    raising a 403 the attacker could observe directly.
    """
    progress = await get_user_progress(session, user_id)
    return is_stage_unlocked(stage_number, progress)


@router.get("/stages/{stage_number}/content", response_model=None)
async def list_stage_content(
    stage_number: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    pagination: Annotated[PaginationParams, Depends()],
) -> Page[ContentItemResponse] | list[ContentItemResponse]:
    """List content for a stage with drip-feed gating applied.

    BUG-INFRA-018: returns ``Page[ContentItemResponse]`` when
    ``?paginate=true`` is set; otherwise the legacy bare list is returned
    for one release while the frontend migrates to the envelope.

    Pagination is applied **after** drip-feed filtering so the envelope's
    ``total`` reflects the items the user can actually see — not the raw
    count in the database.  Stage content lists are small (tens of items
    per stage) so paginating in Python after fetching is fine.

    The sibling endpoints (``get_content_item``, ``mark_content_read``)
    gate on :func:`_check_stage_unlocked`; this listing used to skip it
    and leak titles + release_days for future stages while only nulling
    ``url``.  Aligning the unlock gate here closes the last read path
    for locked-stage metadata.
    """
    # 404-then-403: missing stages return not_found regardless of caller so a
    # nonexistent stage_number can't be distinguished from a locked one by
    # response code (callers for this endpoint don't see a content_id oracle,
    # so the existence of stages 1..36 is already public knowledge).
    stage = await _get_stage_by_number(session, stage_number)
    await _check_stage_unlocked(session, current_user, stage_number)

    result = await session.execute(
        select(StageContent)
        .where(StageContent.course_stage_id == stage.id)
        .order_by(col(StageContent.release_day).asc())
    )
    items = list(result.scalars().all())

    days = await _days_for_user_stage(session, current_user, stage_number)
    content_ids = [item.id for item in items if item.id is not None]
    read_ids = await _read_ids_for_user(session, current_user, content_ids)

    raw = _items_to_raw_dicts(items)
    filtered = filter_content_for_user(raw, days_elapsed=max(days, -1), read_content_ids=read_ids)
    responses = [ContentItemResponse(**f) for f in filtered]

    if pagination.paginate:
        sliced = responses[pagination.offset : pagination.offset + pagination.limit]
        return build_page(sliced, len(responses), pagination)
    return responses


@router.get("/content/{content_id}", response_model=ContentItemResponse)
async def get_content_item(
    content_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ContentItemResponse:
    """Get a single content item with lock/read status.

    BUG-COURSE-004: collapses the "stage locked" 403 into a 404 so an
    attacker enumerating ``content_id`` cannot distinguish "row exists
    but locked for me" from "row does not exist".  Course content is a
    shared catalog, not a user-owned resource, so the canonical 403
    leak surface is content-row count + stage boundaries; masking the
    locked branch as ``content_not_found`` removes the oracle.
    """
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

    # BUG-COURSE-004: mask locked-stage access as 404 so locked content
    # is indistinguishable from nonexistent content over the wire.
    if not await _is_stage_unlocked_for_user(session, current_user, stage.stage_number):
        raise not_found("content")

    days = await _days_for_user_stage(session, current_user, stage.stage_number)

    item_id = item.id
    if item_id is None:
        msg = "StageContent ID unexpectedly None after database fetch"
        raise RuntimeError(msg)
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
    filtered = filter_content_for_user(raw, days_elapsed=max(days, -1), read_content_ids=read_ids)
    return ContentItemResponse(**filtered[0])


@router.post("/content/{content_id}/mark-read", response_model=ContentCompletionResponse)
async def mark_content_read(
    content_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ContentCompletionResponse:
    """Mark a content item as read. Idempotent — repeated calls return existing record.

    BUG-COURSE-004: locked-stage access is reported as 404 (not 403) so
    the same enumeration mask applied to ``GET /content/{id}`` also
    holds here.  ``ContentCompletionResponse`` no longer echoes
    ``user_id``: the row is created for ``current_user`` and the
    surrogate key adds nothing for the client.
    """
    # Verify content exists
    result = await session.execute(select(StageContent).where(StageContent.id == content_id))
    content_item = result.scalars().first()
    if content_item is None:
        raise not_found("content")

    # BUG-COURSE-005: Look up the parent stage and verify unlock
    stage_result = await session.execute(
        select(CourseStage).where(CourseStage.id == content_item.course_stage_id)
    )
    stage = stage_result.scalars().first()
    if stage is None:
        raise not_found("stage")
    if not await _is_stage_unlocked_for_user(session, current_user, stage.stage_number):
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
            content_id=existing.content_id,
            completed_at=existing.completed_at,
        )

    completion = ContentCompletion(user_id=current_user, content_id=content_id)
    session.add(completion)
    await session.commit()
    await session.refresh(completion)
    logger.info("content_marked_read", extra={"user_id": current_user, "content_id": content_id})
    return ContentCompletionResponse(
        id=completion.id,
        content_id=completion.content_id,
        completed_at=completion.completed_at,
    )


def _empty_progress() -> CourseProgressResponse:
    """Return a zero-progress response for stages with no content."""
    return CourseProgressResponse(
        total_items=0, read_items=0, progress_percent=0.0, next_unlock_day=None
    )


def _content_ids_from_items(items: list[StageContent]) -> list[int]:
    """Extract non-None IDs from a list of StageContent."""
    return [item.id for item in items if item.id is not None]


@router.get("/stages/{stage_number}/progress", response_model=CourseProgressResponse)
async def get_course_progress(
    stage_number: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> CourseProgressResponse:
    """Get read-progress for a stage's content."""
    if not await stage_exists(session, stage_number):
        raise not_found("stage")

    stage = await _get_stage_by_number(session, stage_number)
    result = await session.execute(
        select(StageContent).where(StageContent.course_stage_id == stage.id)
    )
    items = list(result.scalars().all())

    if not items:
        return _empty_progress()

    read_ids = await _read_ids_for_user(session, current_user, _content_ids_from_items(items))
    progress_pct = round((len(read_ids) / len(items)) * 100, 2)
    days = await _days_for_user_stage(session, current_user, stage_number)

    # BUG-COURSE-004: Don't compute next_unlock_day when days_elapsed is
    # negative (user hasn't started this stage) or for past stages.
    nud: int | None = None
    if 0 <= days < _PAST_STAGE_DAYS_SENTINEL:
        nud = next_unlock_day(release_days=[item.release_day for item in items], days_elapsed=days)

    return CourseProgressResponse(
        total_items=len(items),
        read_items=len(read_ids),
        progress_percent=progress_pct,
        next_unlock_day=nud,
    )
