"""Course content API — drip-fed content with read-tracking."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from content_config import CONTENT_REF_SCHEME, content_ref
from database import get_session
from domain.course import compute_days_elapsed, filter_content_for_user, next_unlock_day
from domain.stage_progress import ensure_user_progress, get_user_progress, is_stage_unlocked
from errors import forbidden, not_found
from models.content_completion import ContentCompletion
from models.course_stage import CourseStage
from models.stage_content import StageContent
from rate_limit import limiter
from routers.auth import get_current_user
from schemas import Page, PaginationParams, build_page
from schemas.course import (
    ContentBodyResponse,
    ContentCompletionResponse,
    ContentItemResponse,
    CourseProgressResponse,
    SiteResourceResponse,
)
from services.content_repository import (
    ContentBody,
    ContentNotFoundError,
    ContentRepositoryError,
    get_content_repository,
)

# Body endpoints read Markdown off local disk now, but the cap stays as
# defense-in-depth (it is cheap, and it kept a single authenticated user
# from hammering the old CMS proxy — no reason to hand back the headroom).
_CMS_PROXY_RATE_LIMIT = "30/minute"

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

    First course access provisions a ``current_stage=1`` StageProgress
    row via :func:`ensure_user_progress`, so the drip-feed clock has a
    real ``stage_started_at`` even for users who never explicitly
    advanced a stage — without it every chapter read as locked.

    Returns:
    - ``_PAST_STAGE_DAYS_SENTINEL`` when the user has already moved past
      this stage (all content should be unlocked).
    - The actual days elapsed when the user is currently on this stage.
    - ``-1`` when the user has not yet reached this stage.
    """
    progress = await ensure_user_progress(session, user_id)
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


async def _existing_content_completion(
    session: AsyncSession, user_id: int, content_id: int
) -> ContentCompletion | None:
    """Return the user's existing completion row for ``content_id`` if any."""
    result = await session.execute(
        select(ContentCompletion).where(
            ContentCompletion.user_id == user_id,
            ContentCompletion.content_id == content_id,
        )
    )
    return result.scalars().first()


def _completion_response(completion: ContentCompletion) -> ContentCompletionResponse:
    return ContentCompletionResponse(
        id=completion.id,
        content_id=completion.content_id,
        completed_at=completion.completed_at,
    )


async def _resolve_unlocked_content(
    session: AsyncSession,
    user_id: int,
    content_id: int,
) -> StageContent:
    """Fetch ``content_id`` and gate on the parent stage being unlocked.

    Locked stages mask as 404 (BUG-COURSE-004) — content_id is an
    enumeration oracle, so a 403 would let an attacker tell "exists but
    locked" apart from "does not exist".  Mirrors :func:`get_content_item`.
    Split out of :func:`mark_content_read` so the route stays at xenon
    rank A and the resolution / authorisation steps are independently
    testable.
    """
    result = await session.execute(select(StageContent).where(StageContent.id == content_id))
    content_item = result.scalars().first()
    if content_item is None:
        raise not_found("content")
    stage_result = await session.execute(
        select(CourseStage).where(CourseStage.id == content_item.course_stage_id)
    )
    stage = stage_result.scalars().first()
    if stage is None:
        raise not_found("stage")
    if not await _is_stage_unlocked_for_user(session, user_id, stage.stage_number):
        raise not_found("content")
    return content_item


async def _insert_or_resolve_completion(
    session: AsyncSession,
    user_id: int,
    content_id: int,
) -> ContentCompletion:
    """Insert a new completion or return the winner's row on race.

    ``begin_nested`` opens a SAVEPOINT so the unique-constraint
    ``IntegrityError`` rolls back only the failed insert; the outer
    transaction stays healthy enough for the follow-up SELECT.
    Defensively raises if the constraint fired but the winner's row is
    missing — that would mean the database invariant is broken and a
    silent re-insert would compound the corruption.
    """
    completion = ContentCompletion(user_id=user_id, content_id=content_id)
    try:
        async with session.begin_nested():
            session.add(completion)
        await session.commit()
        await session.refresh(completion)
    except IntegrityError as exc:
        existing = await _existing_content_completion(session, user_id, content_id)
        if existing is None:
            # Preserve the chain: the constraint name + driver-level
            # error reach Sentry / logs so we can debug a corrupt-DB
            # scenario rather than silently re-inserting.
            msg = "ContentCompletion lost the race but the winner's row is missing"
            raise RuntimeError(msg) from exc
        return existing
    return completion


@router.post("/content/{content_id}/mark-read", response_model=ContentCompletionResponse)
async def mark_content_read(
    content_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ContentCompletionResponse:
    """Mark a content item as read. Idempotent — repeated calls return existing record.

    The pre-check is the fast path for the common retry / refresh case.
    Two concurrent calls can both pass it; the
    ``uq_contentcompletion_user_content`` constraint then catches the
    loser via ``IntegrityError`` and the existing row is returned —
    closes the BUG-COURSE-002 TOCTOU.
    """
    await _resolve_unlocked_content(session, current_user, content_id)

    existing = await _existing_content_completion(session, current_user, content_id)
    if existing is not None:
        return _completion_response(existing)

    completion = await _insert_or_resolve_completion(session, current_user, content_id)
    logger.info("content_marked_read", extra={"user_id": current_user, "content_id": content_id})
    return _completion_response(completion)


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
    """Get read-progress for a stage's content; 403 when the caller has not unlocked it."""
    stage = await _get_stage_by_number(session, stage_number)
    await _check_stage_unlocked(session, current_user, stage_number)
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


# --------------------------------------------------------------------------- #
# In-app local-content rendering                                               #
# --------------------------------------------------------------------------- #


_CONTENT_UNAVAILABLE_DETAIL = "content_unavailable"

#: ``StageContent.url`` prefix for manifest-driven rows (see content_config).
_CONTENT_REF_PREFIX = f"{CONTENT_REF_SCHEME}://"


def _read_local_body(read: Callable[[], ContentBody], reference: str) -> ContentBodyResponse:
    """Run a ContentRepository read, mapping errors to HTTPExceptions.

    An unknown id/slug keeps the 404 mask (``content_not_found`` — the
    caller cannot distinguish "never existed" from "not for you").  Any
    other repository failure means the vendored content is broken — a
    manifest-listed file is missing or the manifest itself is unreadable
    — which is a server bug surfaced as ``502 content_unavailable``.
    There is no auth failure mode: local files need no credentials, so
    ``cms_auth_failed`` is gone.
    """
    try:
        body = read()
    except ContentNotFoundError:
        raise not_found("content") from None
    except ContentRepositoryError as exc:
        logger.exception("content_read_failed", extra={"reference": reference})
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=_CONTENT_UNAVAILABLE_DETAIL,
        ) from exc
    return ContentBodyResponse(
        title=body.title,
        content_type=body.content_type,
        body_markdown=body.body,
    )


async def _load_content_with_stage(
    session: AsyncSession, content_id: int
) -> tuple[StageContent, CourseStage]:
    """Load ``content_id`` and its parent stage, 404-ing on either miss."""
    result = await session.execute(select(StageContent).where(StageContent.id == content_id))
    item = result.scalars().first()
    if item is None:
        raise not_found("content")
    stage_result = await session.execute(
        select(CourseStage).where(CourseStage.id == item.course_stage_id)
    )
    stage = stage_result.scalars().first()
    if stage is None:
        raise not_found("stage")
    return item, stage


async def _check_released_for_user(
    session: AsyncSession, user_id: int, stage_number: int, release_day: int
) -> None:
    """Raise 404 unless the user has reached ``release_day`` on this stage.

    Mirrors the drip-feed gating applied on the metadata endpoint so the
    in-app body endpoint cannot leak a chapter ahead of its release_day.
    """
    days = await _days_for_user_stage(session, user_id, stage_number)
    if 0 <= days < _PAST_STAGE_DAYS_SENTINEL and release_day > days:
        raise not_found("content")


async def _resolve_released_content_ref(
    session: AsyncSession, user_id: int, content_id: int
) -> str:
    """Gate on stage-unlock + release_day, return the local chapter id.

    Mirrors the 404-mask used by sibling endpoints (BUG-COURSE-004):
    locked, unreleased, missing-reference, and nonexistent rows all
    surface as ``content_not_found`` so ``content_id`` is not an
    enumeration oracle.  Rows without a ``content://`` reference
    (legacy/placeholder rows) have no local body and fall under the same
    mask.
    """
    item, stage = await _load_content_with_stage(session, content_id)
    if not await _is_stage_unlocked_for_user(session, user_id, stage.stage_number):
        raise not_found("content")
    await _check_released_for_user(session, user_id, stage.stage_number, item.release_day)
    reference = item.url or ""
    if not reference.startswith(_CONTENT_REF_PREFIX):
        raise not_found("content")
    return reference.removeprefix(_CONTENT_REF_PREFIX)


@router.get("/content/{content_id}/body", response_model=ContentBodyResponse)
@limiter.limit(_CMS_PROXY_RATE_LIMIT)
async def get_content_body(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    content_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ContentBodyResponse:
    """Return raw Markdown for a content item from the vendored content.

    Mirrors :func:`get_content_item` for gating — a locked or non-existent
    content row both return ``content_not_found`` (BUG-COURSE-004) so the
    URL cannot be used as an enumeration oracle.  The drip-feed unlock
    check is applied here too: locked-day content never escapes.
    """
    chapter_id = await _resolve_released_content_ref(session, current_user, content_id)
    return _read_local_body(lambda: get_content_repository().read_body(chapter_id), chapter_id)


@router.get("/site-resources", response_model=list[SiteResourceResponse])
async def list_site_resources(
    _current_user: Annotated[int, Depends(get_current_user)],
) -> list[SiteResourceResponse]:
    """Return the site-wide resource links from the content manifest.

    These pages (philosophy, about, …) are not stage-gated, but we still
    require authentication so the list is not crawlable by anyone with
    the URL.  The manifest's ``site_resources[]`` is the source of truth
    (issue #395); without a usable manifest — the bootstrap state before
    the first content pin — the list is simply empty.  ``url`` is kept
    for response-surface stability and carries the local content
    reference, not a fetchable address.
    """
    try:
        resources = get_content_repository().list_resources()
    except ContentRepositoryError as exc:
        logger.warning("No usable content manifest; no site resources: %s", exc)
        return []
    return [
        SiteResourceResponse(
            slug=resource.slug,
            title=resource.title,
            description=resource.description,
            url=content_ref(resource.slug),
        )
        for resource in resources
    ]


@router.get("/site-resources/{slug}/body", response_model=ContentBodyResponse)
@limiter.limit(_CMS_PROXY_RATE_LIMIT)
async def get_site_resource_body(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    slug: str,
    _current_user: Annotated[int, Depends(get_current_user)],
) -> ContentBodyResponse:
    """Return raw Markdown for a manifest-listed site resource.

    The manifest is the gate on which slugs exist — an unknown slug is a
    plain 404 via the repository's ``ContentNotFoundError``.
    """
    return _read_local_body(lambda: get_content_repository().read_resource_body(slug), slug)
