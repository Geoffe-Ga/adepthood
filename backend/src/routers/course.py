"""Course content API — drip-fed content with read-tracking."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from content_config import CONTENT_REF_SCHEME, content_ref
from database import get_session
from dependencies.timezone import current_user_timezone
from domain.constants import STAGE_DURATIONS_DAYS
from domain.course import (
    compute_days_elapsed,
    enrich_content_item,
    filter_content_for_user,
    next_unlock_day,
    unlocked_chapter_count,
)
from domain.program_calendar import calendar_day_in_stage, resolve_program_anchor
from domain.stage_progress import ensure_user_progress, get_user_progress, is_stage_unlocked
from errors import bad_gateway, forbidden, not_found
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
    StageIntroResponse,
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


def _stage_duration_days(stage_number: int) -> int:
    """Days the given 1-based stage lasts (the app-owned drip window).

    ``STAGE_DURATIONS_DAYS`` is app-owned on purpose (issue #386): the
    content package deliberately does not know stage durations, so the
    proportional drip denominator has to come from here.  Out-of-range
    numbers clamp to the curriculum so a stray value can never
    ``IndexError``.
    """
    index = min(max(stage_number, 1), len(STAGE_DURATIONS_DAYS)) - 1
    return STAGE_DURATIONS_DAYS[index]


async def _get_stage_by_number(session: AsyncSession, stage_number: int) -> CourseStage:
    """Fetch a CourseStage by number or raise 404."""
    result = await session.execute(
        select(CourseStage).where(CourseStage.stage_number == stage_number)
    )
    stage = result.scalars().first()
    if stage is None:
        raise not_found("stage")
    return stage


async def _day_in_stage_for_user(
    session: AsyncSession, user_id: int, stage_number: int, tz: str
) -> int:
    """The 1-based day the user is on within ``stage_number`` for the drip.

    First course access provisions a ``current_stage=1`` StageProgress row
    via :func:`ensure_user_progress`, so the clock has a real anchor even
    for users who never explicitly advanced a stage.

    Advancement is honored so time can only widen access, never revoke it:

    - a **past** stage returns its full duration → every chapter open;
    - the **current** stage runs on whichever is further along, the
      program calendar or how long the user has actually sat on the stage
      (``max`` of the two), so an early advancer is never penalized;
    - a **not-yet-current** stage the calendar has already opened uses the
      calendar day.  This is the fix for the old ``-1``: a stage unlocked
      by ``calendar_stage`` (ahead of ``current_stage``) used to read as
      "-1 days", locking every one of its chapters.
    """
    progress = await ensure_user_progress(session, user_id)
    duration = _stage_duration_days(stage_number)
    if progress.current_stage > stage_number:
        return duration
    calendar_day = calendar_day_in_stage(resolve_program_anchor(progress), stage_number, tz=tz)
    if progress.current_stage == stage_number:
        started_day = compute_days_elapsed(progress.stage_started_at) + 1
        return max(calendar_day, started_day)
    return calendar_day


async def _stage_content_count(session: AsyncSession, stage_id: int) -> int:
    """Total content rows for a stage — the proportional drip denominator."""
    result = await session.execute(
        select(func.count())
        .select_from(StageContent)
        .where(StageContent.course_stage_id == stage_id)
    )
    return result.scalar() or 0


async def _ordinal_position(session: AsyncSession, item: StageContent) -> int:
    """0-based rank of ``item`` within its stage, ordered by (release_day, id).

    Mirrors the ``ORDER BY release_day, id`` the listing endpoint uses, so
    a single-item lock check agrees with the list view even when
    ``release_day`` has gaps or ties.
    """
    result = await session.execute(
        select(func.count())
        .select_from(StageContent)
        .where(
            StageContent.course_stage_id == item.course_stage_id,
            or_(
                col(StageContent.release_day) < item.release_day,
                (col(StageContent.release_day) == item.release_day)
                & (col(StageContent.id) < item.id),
            ),
        )
    )
    return result.scalar() or 0


async def _content_item_is_locked(
    session: AsyncSession, user_id: int, stage: CourseStage, item: StageContent, tz: str
) -> bool:
    """Whether ``item`` is drip-locked for the user under the proportional model."""
    day = await _day_in_stage_for_user(session, user_id, stage.stage_number, tz)
    if stage.id is None:
        raise RuntimeError("CourseStage from database must have an id")
    total = await _stage_content_count(session, stage.id)
    unlocked = unlocked_chapter_count(
        total=total,
        duration_days=_stage_duration_days(stage.stage_number),
        day_in_stage=day,
    )
    position = await _ordinal_position(session, item)
    return position >= unlocked


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


async def _check_stage_unlocked(
    session: AsyncSession, user_id: int, stage_number: int, tz: str
) -> None:
    """Raise 403 if the given stage is locked for the user.

    Used by endpoints that take ``stage_number`` directly (1..10 are
    public knowledge), so the 403 carries no enumeration risk.
    """
    progress = await get_user_progress(session, user_id)
    if not is_stage_unlocked(stage_number, progress, tz=tz):
        raise forbidden("stage_locked")


async def _is_stage_unlocked_for_user(
    session: AsyncSession, user_id: int, stage_number: int, tz: str
) -> bool:
    """Predicate form of :func:`_check_stage_unlocked`.

    Used on ``content_id``-keyed endpoints (BUG-COURSE-004): callers mask
    the locked branch as 404 to remove the existence oracle, rather than
    raising a 403 the attacker could observe directly.
    """
    progress = await get_user_progress(session, user_id)
    return is_stage_unlocked(stage_number, progress, tz=tz)


async def _listing_unlocked_count(
    session: AsyncSession, user_id: int, stage: CourseStage, total_items: int, tz: str
) -> int:
    """Chapters to reveal in the stage listing.

    A stage still locked for the user is shown as a titles-only table of
    contents: every item locked with its ``url`` nulled -- the same shape
    the drip produces at ``unlocked_count == 0``. This deliberately shows
    the whole chapter map in the course drawer while keeping bodies and
    urls out of reach; item detail and mark-read stay gated. An unlocked
    stage keeps its proportional drip count unchanged.
    """
    if not await _is_stage_unlocked_for_user(session, user_id, stage.stage_number, tz):
        return 0
    day = await _day_in_stage_for_user(session, user_id, stage.stage_number, tz)
    return unlocked_chapter_count(
        total=total_items,
        duration_days=_stage_duration_days(stage.stage_number),
        day_in_stage=day,
    )


@router.get("/stages/{stage_number}/content", response_model=None)
async def list_stage_content(
    stage_number: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
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

    A stage still locked for the user returns a titles-only listing on
    purpose: the course drawer renders the full chapter map (every item
    locked with ``url`` nulled) while bodies and urls stay protected.
    Item detail (``get_content_item``) and ``mark_content_read`` remain
    gated -- only this table-of-contents view is open on a locked stage.
    """
    # A missing stage still 404s here so a nonexistent stage_number can't be
    # confused with a real one; stages 1..10 are public knowledge, and the
    # listing itself is open (titles-only when locked) so there's no oracle.
    stage = await _get_stage_by_number(session, stage_number)

    result = await session.execute(
        select(StageContent)
        .where(StageContent.course_stage_id == stage.id)
        .order_by(col(StageContent.release_day).asc(), col(StageContent.id).asc())
    )
    items = list(result.scalars().all())

    unlocked = await _listing_unlocked_count(session, current_user, stage, len(items), user_tz)
    content_ids = [item.id for item in items if item.id is not None]
    read_ids = await _read_ids_for_user(session, current_user, content_ids)

    raw = _items_to_raw_dicts(items)
    filtered = filter_content_for_user(raw, unlocked_count=unlocked, read_content_ids=read_ids)
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
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> ContentItemResponse:
    """Get a single content item with lock/read status.

    BUG-COURSE-004: collapses the "stage locked" 403 into a 404 so an
    attacker enumerating ``content_id`` cannot distinguish "row exists
    but locked for me" from "row does not exist".  Course content is a
    shared catalog, not a user-owned resource, so the canonical 403
    leak surface is content-row count + stage boundaries; masking the
    locked branch as ``content_not_found`` removes the oracle.
    """
    item, stage = await _load_content_with_stage(session, content_id)
    # BUG-COURSE-004: mask locked-stage access as 404 so locked content
    # is indistinguishable from nonexistent content over the wire.
    if not await _is_stage_unlocked_for_user(session, current_user, stage.stage_number, user_tz):
        raise not_found("content")

    item_id = item.id
    if item_id is None:
        msg = "StageContent ID unexpectedly None after database fetch"
        raise RuntimeError(msg)
    read_ids = await _read_ids_for_user(session, current_user, [item_id])

    is_locked = await _content_item_is_locked(session, current_user, stage, item, user_tz)
    enriched = enrich_content_item(
        _items_to_raw_dicts([item])[0], is_locked=is_locked, read_content_ids=read_ids
    )
    return ContentItemResponse(**enriched)


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
    tz: str,
) -> StageContent:
    """Fetch ``content_id`` and gate on the parent stage being unlocked.

    Locked stages mask as 404 (BUG-COURSE-004) — content_id is an
    enumeration oracle, so a 403 would let an attacker tell "exists but
    locked" apart from "does not exist".  Mirrors :func:`get_content_item`.
    Split out of :func:`mark_content_read` so the route stays at xenon
    rank A and the resolution / authorisation steps are independently
    testable.
    """
    item, stage = await _load_content_with_stage(session, content_id)
    if not await _is_stage_unlocked_for_user(session, user_id, stage.stage_number, tz):
        raise not_found("content")
    return item


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
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> ContentCompletionResponse:
    """Mark a content item as read. Idempotent — repeated calls return existing record.

    The pre-check is the fast path for the common retry / refresh case.
    Two concurrent calls can both pass it; the
    ``uq_contentcompletion_user_content`` constraint then catches the
    loser via ``IntegrityError`` and the existing row is returned —
    closes the BUG-COURSE-002 TOCTOU.
    """
    await _resolve_unlocked_content(session, current_user, content_id, user_tz)

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
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> CourseProgressResponse:
    """Get read-progress for a stage's content; 403 when the caller has not unlocked it."""
    stage = await _get_stage_by_number(session, stage_number)
    await _check_stage_unlocked(session, current_user, stage_number, user_tz)
    result = await session.execute(
        select(StageContent).where(StageContent.course_stage_id == stage.id)
    )
    items = list(result.scalars().all())

    if not items:
        return _empty_progress()

    read_ids = await _read_ids_for_user(session, current_user, _content_ids_from_items(items))
    progress_pct = round((len(read_ids) / len(items)) * 100, 2)
    day = await _day_in_stage_for_user(session, current_user, stage_number, user_tz)

    # ``total_items`` stays the whole-stage count (not the unlocked count)
    # so "stage complete" only fires when everything is read; the drip only
    # governs how many are openable right now, surfaced via next_unlock_day.
    nud = next_unlock_day(
        total=len(items),
        duration_days=_stage_duration_days(stage_number),
        day_in_stage=day,
    )

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
        raise bad_gateway(_CONTENT_UNAVAILABLE_DETAIL) from exc
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


async def _resolve_released_content_ref(
    session: AsyncSession, user_id: int, content_id: int, tz: str
) -> str:
    """Gate on stage-unlock + proportional drip, return the local chapter id.

    Mirrors the 404-mask used by sibling endpoints (BUG-COURSE-004):
    locked-stage, drip-locked, missing-reference, and nonexistent rows all
    surface as ``content_not_found`` so ``content_id`` is not an
    enumeration oracle.  The drip check is by ordinal position (same model
    as the metadata endpoint), so a chapter cannot be read ahead of its
    proportional release.  Rows without a ``content://`` reference
    (legacy/placeholder rows) have no local body and fall under the same
    mask.
    """
    item, stage = await _load_content_with_stage(session, content_id)
    if not await _is_stage_unlocked_for_user(session, user_id, stage.stage_number, tz):
        raise not_found("content")
    if await _content_item_is_locked(session, user_id, stage, item, tz):
        raise not_found("content")
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
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> ContentBodyResponse:
    """Return raw Markdown for a content item from the vendored content.

    Mirrors :func:`get_content_item` for gating — a locked or non-existent
    content row both return ``content_not_found`` (BUG-COURSE-004) so the
    URL cannot be used as an enumeration oracle.  The drip-feed unlock
    check is applied here too: locked-day content never escapes.
    """
    chapter_id = await _resolve_released_content_ref(session, current_user, content_id, user_tz)
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


async def _require_unlocked_stage(
    session: AsyncSession,
    user_id: int,
    stage_number: int,
    tz: str,
) -> None:
    """Require the stage to exist and be unlocked for ``user_id``.

    A nonexistent stage is a plain ``stage`` 404; a locked stage is masked as
    ``content`` (BUG-COURSE-004) so a locked stage's intro is indistinguishable
    from a nonexistent one over the wire.
    """
    await _get_stage_by_number(session, stage_number)
    if not await _is_stage_unlocked_for_user(session, user_id, stage_number, tz):
        raise not_found("content")


@router.get("/stages/{stage_number}/intro", response_model=StageIntroResponse)
async def get_stage_introduction(
    stage_number: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> StageIntroResponse:
    """Return a stage's course-introduction metadata.

    Ungated by ``release_day`` but gated by stage-unlock: a locked stage and a
    stage with no intro both return ``content_not_found`` (BUG-COURSE-004) so
    neither acts as an enumeration oracle.
    """
    await _require_unlocked_stage(session, current_user, stage_number, user_tz)
    intro = get_content_repository().get_stage_intro(stage_number)
    if intro is None:
        raise not_found("content")
    return StageIntroResponse(
        stage=intro.stage,
        id=intro.id,
        slug=intro.slug,
        title=intro.title,
        summary=intro.summary,
    )


@router.get("/stages/{stage_number}/intro/body", response_model=ContentBodyResponse)
@limiter.limit(_CMS_PROXY_RATE_LIMIT)
async def get_stage_intro_body(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    stage_number: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> ContentBodyResponse:
    """Return raw Markdown for a stage's course introduction.

    Same gating as :func:`get_stage_introduction`. The read goes through
    :func:`_read_local_body`, so an unknown stage keeps the 404 mask and a
    broken repository surfaces as ``502 content_unavailable``.
    """
    await _require_unlocked_stage(session, current_user, stage_number, user_tz)
    return _read_local_body(
        lambda: get_content_repository().read_intro_body(stage_number),
        f"stage-{stage_number}-intro",
    )
