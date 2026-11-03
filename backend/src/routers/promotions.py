"""Quote-promotion API — lift a span from a source, optionally fold it into a review.

Promoting a quote anchors a character span of its source -- a journal entry, a
Course chapter, or a Resonance Letter -- and the server slices and snapshots the
text (the client sends only offsets) so the quote survives later edits. All
three write routes share one slicer, :func:`_slice_anchor_text` (#3658). A
promotion can then be folded into a hierarchical reflection or returned to
pending. ``GET /promotions`` lists every quote the caller has promoted, of every
kind (#3656), for the Promoted quotes screen (#2865). ``user_id`` is never
returned.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any, NamedTuple, cast

from fastapi import Depends, Query, Request, Response, status
from sqlalchemy import ColumnElement, and_, or_
from sqlalchemy import select as select_columns
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlalchemy.sql import Select
from sqlmodel import col, select

from bounds import MAX_PAGE_OFFSET, RowIdPath
from database import get_session
from dependencies.ownership import (
    require_owned_journal_entry,
    require_owned_marginalia,
    resolve_owned_live_entry,
)
from dependencies.timezone import current_user_timezone
from error_responses import build_router, refusal_responses
from errors import not_found, unprocessable
from models.course_stage import CourseStage
from models.journal_entry import JournalEntry, JournalTag
from models.marginalia import Marginalia
from models.promoted_quote import (
    PROMOTED_QUOTE_SOURCE_TITLE_MAX,
    PROMOTED_QUOTE_TEXT_MAX,
    PromotedQuote,
    PromotedQuoteSourceKind,
)
from models.stage_content import StageContent
from observability import route_template
from rate_limit import limiter
from routers.auth import get_current_user
from routers.course import read_released_body, resolve_released_chapter
from schemas.pagination import DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, count_query_total, page_has_more
from schemas.promotion import (
    PromoteChapterQuoteCreate,
    PromotedQuoteListItemResponse,
    PromotedQuoteListResponse,
    PromotedQuoteResponse,
    PromoteQuoteCreate,
    PromotionStatusFilter,
    PromotionUpdate,
    QuoteSpan,
)
from security import TextTooLongError, sanitize_user_text
from services import demo_visibility
from services.folded_quote_privacy import (
    refuse_unfoldable_quote,
    refuse_unquotable_letter_text,
    refuse_unquotable_span,
)
from services.journal_withdrawal_obligation import refuse_if_deletion_pending

logger = logging.getLogger(__name__)

router = build_router(tags=["promotions"], extra_statuses=(status.HTTP_409_CONFLICT,))

# A list read, limited like the journal list it sits beside (#2865).
LIST_PROMOTIONS_RATE_LIMIT = "30/minute"


def _quote_response(quote: PromotedQuote) -> PromotedQuoteResponse:
    """Map a promoted-quote row to its user_id-free response DTO."""
    return PromotedQuoteResponse(
        id=cast("int", quote.id),
        source_kind=PromotedQuoteSourceKind(quote.source_kind),
        source_entry_id=quote.source_entry_id,
        source_content_id=quote.source_content_id,
        source_marginalia_id=quote.source_marginalia_id,
        anchor_start=quote.anchor_start,
        anchor_end=quote.anchor_end,
        anchor_text=quote.anchor_text,
        pending=quote.included_in_entry_id is None,
        stale=quote.stale,
    )


def _slice_anchor_text(body: str, payload: QuoteSpan) -> str:
    """Slice + sanitize the anchored span from a server-held source body.

    ``body`` is an entry's message, a chapter's served Markdown, or a letter.
    Offsets are Unicode code points (Python string indexing is code-point-based),
    which is the anchor API's contract. The span is validated against the
    *server-held* body (never client text): an end past the body length is 422
    ``anchor_out_of_range``, and a normalized span longer than the plaintext cap
    is 422 ``quote_too_long``.
    """
    if payload.anchor_end > len(body):
        raise unprocessable("anchor_out_of_range")
    span = body[payload.anchor_start : payload.anchor_end]
    try:
        return sanitize_user_text(span, max_len=PROMOTED_QUOTE_TEXT_MAX)
    except TextTooLongError as exc:
        raise unprocessable("quote_too_long") from exc


@router.post(
    "/journal/{entry_id}/promote",
    response_model=PromotedQuoteResponse,
    status_code=status.HTTP_201_CREATED,
)
async def promote_quote(
    payload: PromoteQuoteCreate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    entry: Annotated[JournalEntry, Depends(require_owned_journal_entry)],
) -> PromotedQuoteResponse:
    """Promote a span of the caller's own entry into a pending quote.

    Ownership is enforced by ``require_owned_journal_entry`` (a missing,
    soft-deleted, or foreign entry all resolve to 404). The span is sliced and
    snapshotted server-side, so the quote starts life pending (unfolded).

    A source that may not egress (Intimate, or an unknown tier), or a span over
    a passage the source holds from a restricted fold, is 409
    ``quote_source_restricted`` and stores nothing (#3059, owner decision R5-2).
    """
    await refuse_if_deletion_pending(session, entry)
    anchor_text = _slice_anchor_text(entry.message, payload)
    await refuse_unquotable_span(session, entry, payload.anchor_start, payload.anchor_end)
    quote = PromotedQuote(
        user_id=current_user,
        source_kind=PromotedQuoteSourceKind.ENTRY,
        source_entry_id=cast("int", entry.id),
        anchor_start=payload.anchor_start,
        anchor_end=payload.anchor_end,
        anchor_text=anchor_text,
        included_in_entry_id=None,
    )
    return await _persist_quote(session, quote)


@router.get("/journal/{entry_id}/promotions", response_model=list[PromotedQuoteResponse])
async def list_promotions(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    entry: Annotated[JournalEntry, Depends(require_owned_journal_entry)],
) -> list[PromotedQuoteResponse]:
    """List every promoted quote anchored in the caller's own entry.

    Ownership is enforced by ``require_owned_journal_entry`` (a missing,
    soft-deleted, or foreign entry all resolve to 404). Results are scoped to
    this entry and the caller, ordered by ``(anchor_start, id)``, and include
    every quote regardless of status -- pending, folded, and stale -- so a
    reopened entry can rehydrate all of its highlights.
    """
    result = await session.execute(
        select(PromotedQuote)
        .where(
            PromotedQuote.source_entry_id == entry.id,
            PromotedQuote.user_id == current_user,
        )
        .order_by(col(PromotedQuote.anchor_start), col(PromotedQuote.id))
    )
    return [_quote_response(quote) for quote in result.scalars().all()]


async def _source_quotes(
    request: Request, session: AsyncSession, user_id: int, source: ColumnElement[bool]
) -> list[PromotedQuoteResponse]:
    """The caller's quotes matching ``source``, every status, ordered by ``(anchor_start, id)``.

    ``request`` is what ``@limiter.limit`` keys on; naming the path it served
    keeps the read observable beside the write events.
    """
    result = await session.execute(
        select(PromotedQuote)
        .where(source, PromotedQuote.user_id == user_id)
        .order_by(col(PromotedQuote.anchor_start), col(PromotedQuote.id))
    )
    quotes = [_quote_response(quote) for quote in result.scalars().all()]
    logger.info(
        "source_promotions_listed",
        extra={"user_id": user_id, "count": len(quotes), "path": route_template(request)},
    )
    return quotes


async def _persist_quote(session: AsyncSession, quote: PromotedQuote) -> PromotedQuoteResponse:
    """Store a freshly sliced quote and log it, as every promote route does."""
    session.add(quote)
    await session.commit()
    await session.refresh(quote)
    logger.info(
        "quote_promoted",
        extra={"user_id": quote.user_id, "quote_id": quote.id, "source_kind": quote.source_kind},
    )
    return _quote_response(quote)


# ── Course chapters (#3658) ──────────────────────────────────────────────


def _course_source(content_id: int) -> ColumnElement[bool]:
    """Quotes lifted from the chapter row ``content_id``."""
    return and_(
        col(PromotedQuote.source_kind) == PromotedQuoteSourceKind.COURSE.value,
        col(PromotedQuote.source_content_id) == content_id,
    )


@router.post(
    "/course/content/{content_id}/promote",
    response_model=PromotedQuoteResponse,
    status_code=status.HTTP_201_CREATED,
    responses=refusal_responses((status.HTTP_502_BAD_GATEWAY,)),
)
async def promote_course_quote(
    content_id: RowIdPath,
    payload: PromoteChapterQuoteCreate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> PromotedQuoteResponse:
    """Promote a span of a released Course chapter into a pending quote.

    The chapter answers through the gate ``GET /course/content/{content_id}/body``
    uses: a locked, unreleased, reference-less or missing chapter is 404
    ``content_not_found``, masked identically (BUG-COURSE-004), and stores
    nothing. Offsets are code points into ``body_markdown`` exactly as that
    endpoint serves it (frontmatter stripped); an end past it is 422
    ``anchor_out_of_range`` and an overlong span 422 ``quote_too_long``. The
    chapter title is snapshotted into ``source_title``, so the quote keeps its
    name if the chapter is later pruned. A broken vendored file is 502
    ``content_unavailable``. Course text is published, so there is no tier to
    refuse on.
    """
    chapter = await resolve_released_chapter(session, current_user, content_id, user_tz)
    anchor_text = _slice_anchor_text(read_released_body(chapter).body_markdown, payload)
    quote = PromotedQuote(
        user_id=current_user,
        source_kind=PromotedQuoteSourceKind.COURSE,
        source_content_id=content_id,
        source_title=chapter.content.title[:PROMOTED_QUOTE_SOURCE_TITLE_MAX],
        anchor_start=payload.anchor_start,
        anchor_end=payload.anchor_end,
        anchor_text=anchor_text,
        included_in_entry_id=None,
    )
    return await _persist_quote(session, quote)


@router.get("/course/content/{content_id}/promotions", response_model=list[PromotedQuoteResponse])
@limiter.limit(LIST_PROMOTIONS_RATE_LIMIT)
async def list_course_promotions(
    request: Request,
    content_id: RowIdPath,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_tz: Annotated[str, Depends(current_user_timezone)],
) -> list[PromotedQuoteResponse]:
    """List the caller's quotes of one released Course chapter, so a reopened chapter rehydrates.

    Through the same gate as the promote route: a chapter the caller may not
    read is 404 ``content_not_found``. Every status -- pending, folded, stale --
    ordered by ``(anchor_start, id)``.
    """
    await resolve_released_chapter(session, current_user, content_id, user_tz)
    return await _source_quotes(request, session, current_user, _course_source(content_id))


# ── Resonance Letters (#3658) ────────────────────────────────────────────


async def _letter_of(
    session: AsyncSession, note: Marginalia, user_id: int
) -> tuple[JournalEntry, str]:
    """The live entry ``note`` sits on and the letter it carries, or 404.

    The entry is resolved under the caller's scope too, so a note that names
    the caller but sits on another account's entry is a 404 like any foreign
    row. A note with no letter -- or with a stored demo letter that is
    withheld (#3096) -- is 404 ``letter_not_found``: there is nothing served
    to quote.
    """
    entry = await resolve_owned_live_entry(session, note.journal_entry_id, user_id)
    letter = demo_visibility.served_letter(note)
    if letter is None:
        raise not_found("letter")
    return entry, letter


def _letter_source(marginalia_id: int) -> ColumnElement[bool]:
    """Quotes lifted from the letter on margin note ``marginalia_id``."""
    return and_(
        col(PromotedQuote.source_kind) == PromotedQuoteSourceKind.LETTER.value,
        col(PromotedQuote.source_marginalia_id) == marginalia_id,
    )


@router.post(
    "/journal/marginalia/{marginalia_id}/letter/promote",
    response_model=PromotedQuoteResponse,
    status_code=status.HTTP_201_CREATED,
)
async def promote_letter_quote(
    payload: PromoteQuoteCreate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    note: Annotated[Marginalia, Depends(require_owned_marginalia)],
) -> PromotedQuoteResponse:
    """Promote a span of the Resonance Letter on the caller's margin note into a pending quote.

    The letter is a facet of its note, so the path names the note. A missing,
    hidden or foreign note is 404 ``marginalia_not_found``; a note on a deleted
    (or foreign) entry is 404 ``journal_entry_not_found``; a note with no letter
    served is 404 ``letter_not_found``. An entry whose deletion is in progress is
    409 ``journal_entry_deletion_pending``. Offsets are code points into the
    letter (letters are write-once, so they never need re-anchoring): an end
    past it is 422 ``anchor_out_of_range``, an overlong span 422
    ``quote_too_long``. A letter inherits its entry's tier: when that entry may
    not egress, or the span carries a passage it holds from a restricted fold,
    the promotion is 409 ``quote_source_restricted``. Nothing is stored on any
    refusal.
    """
    entry, letter = await _letter_of(session, note, current_user)
    await refuse_if_deletion_pending(session, entry)
    anchor_text = _slice_anchor_text(letter, payload)
    await refuse_unquotable_letter_text(session, entry, anchor_text)
    quote = PromotedQuote(
        user_id=current_user,
        source_kind=PromotedQuoteSourceKind.LETTER,
        source_marginalia_id=cast("int", note.id),
        anchor_start=payload.anchor_start,
        anchor_end=payload.anchor_end,
        anchor_text=anchor_text,
        included_in_entry_id=None,
    )
    return await _persist_quote(session, quote)


@router.get(
    "/journal/marginalia/{marginalia_id}/letter/promotions",
    response_model=list[PromotedQuoteResponse],
)
@limiter.limit(LIST_PROMOTIONS_RATE_LIMIT)
async def list_letter_promotions(
    request: Request,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    note: Annotated[Marginalia, Depends(require_owned_marginalia)],
) -> list[PromotedQuoteResponse]:
    """List the caller's quotes of the letter on one margin note, so a reopened letter rehydrates.

    Through the same gates as the promote route: 404 ``marginalia_not_found``,
    ``journal_entry_not_found`` or ``letter_not_found`` as there. Like
    ``GET /journal/{entry_id}/promotions`` it is a read of the caller's own
    quotes, so the tier and deletion-pending refusals do not apply. Every
    status -- pending, folded, stale -- ordered by ``(anchor_start, id)``.
    """
    await _letter_of(session, note, current_user)
    letter_quotes = _letter_source(cast("int", note.id))
    return await _source_quotes(request, session, current_user, letter_quotes)


async def _load_owned_quote(
    session: AsyncSession, promotion_id: int, user_id: int
) -> PromotedQuote | None:
    """Load the caller's own promoted quote, or None (404-scoped, enumeration-safe)."""
    result = await session.execute(
        select(PromotedQuote).where(
            PromotedQuote.id == promotion_id,
            PromotedQuote.user_id == user_id,
        )
    )
    return result.scalars().first()


@router.delete("/promotions/{promotion_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_promotion(
    promotion_id: RowIdPath,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Response:
    """Hard-delete the caller's own promoted quote (the model has no soft-delete).

    A missing or foreign quote resolves to 404, so a second delete of the same
    id 404s (enumeration-safe).
    """
    quote = await _load_owned_quote(session, promotion_id, current_user)
    if quote is None:
        raise not_found("promotion")
    await session.delete(quote)
    await session.commit()
    logger.info(
        "quote_promotion_deleted", extra={"user_id": current_user, "quote_id": promotion_id}
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _validate_inclusion_target(session: AsyncSession, target_id: int, user_id: int) -> None:
    """Ensure ``target_id`` is the caller's own live hierarchical reflection.

    A missing or foreign target is 404; a live but non-reflection target is 422
    ``target_not_reflection`` so a quote can only fold into a reflection page.
    """
    result = await session.execute(
        select(JournalEntry).where(
            JournalEntry.id == target_id,
            JournalEntry.user_id == user_id,
            col(JournalEntry.deleted_at).is_(None),
        )
    )
    target = result.scalars().first()
    if target is None:
        raise not_found("journal_entry")
    if target.tag != JournalTag.HIERARCHICAL_REFLECTION:
        raise unprocessable("target_not_reflection")


@router.patch("/promotions/{promotion_id}", response_model=PromotedQuoteResponse)
async def update_promotion(
    promotion_id: RowIdPath,
    payload: PromotionUpdate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PromotedQuoteResponse:
    """Fold the caller's own quote into a reflection, or return it to pending.

    A missing or foreign promotion is 404. Setting ``included_in_entry_id``
    requires the target to be the caller's own live hierarchical reflection
    (404 / 422 otherwise); ``null`` clears the inclusion back to pending.
    Folding a quote whose source has since become Intimate (or whose text
    carries a passage restricted that way) is 409 ``quote_source_restricted``
    (#3059, owner decision R5-2); returning one to pending is always allowed.
    """
    quote = await _load_owned_quote(session, promotion_id, current_user)
    if quote is None:
        raise not_found("promotion")
    if payload.included_in_entry_id is not None:
        await _validate_inclusion_target(session, payload.included_in_entry_id, current_user)
        await refuse_unfoldable_quote(session, quote)
    quote.included_in_entry_id = payload.included_in_entry_id
    session.add(quote)
    await session.commit()
    await session.refresh(quote)
    logger.info(
        "quote_promotion_updated", extra={"user_id": current_user, "quote_id": promotion_id}
    )
    return _quote_response(quote)


# Each kind of quote reaches its source through its own OUTER join, so no kind
# can make another vanish, and every join onto an account's rows is scoped to the
# caller and to live rows *in the join itself*. The WHERE then keeps an entry
# quote only while its source entry joined, and a letter quote only while the
# entry its margin note sits on joined -- so a deleted (or somehow foreign)
# source drops a quote out of items and total alike. A Course quote is always
# listed: a chapter is published content, shared by every account, and once it
# is pruned the quote keeps the title it snapshotted. The inclusion-target join
# is OUTER as before, so a deleted or foreign review hides only its title, never
# the quote. Three aliases keep the three joins on ``journalentry`` apart.
_Source = aliased(JournalEntry, name="source_entry")
_LetterEntry = aliased(JournalEntry, name="letter_entry")
_Target = aliased(JournalEntry, name="included_entry")

_STATUS_PREDICATES: dict[PromotionStatusFilter, tuple[ColumnElement[bool], ...]] = {
    PromotionStatusFilter.PENDING: (col(PromotedQuote.included_in_entry_id).is_(None),),
    PromotionStatusFilter.INCLUDED: (col(PromotedQuote.included_in_entry_id).is_not(None),),
    PromotionStatusFilter.ALL: (),
}

# Which kinds stay listed, given the joins above.
_SOURCE_IS_LIVE: ColumnElement[bool] = or_(
    and_(
        col(PromotedQuote.source_kind) == PromotedQuoteSourceKind.ENTRY.value,
        col(_Source.id).is_not(None),
    ),
    and_(
        col(PromotedQuote.source_kind) == PromotedQuoteSourceKind.LETTER.value,
        col(_LetterEntry.id).is_not(None),
    ),
    col(PromotedQuote.source_kind) == PromotedQuoteSourceKind.COURSE.value,
)


class _ListRow(NamedTuple):
    """One row of :func:`_all_promotions_query`, in its column order.

    Only the columns of the quote's own kind are populated; the outer joins
    leave the others null.
    """

    quote: PromotedQuote
    entry_title: str | None
    entry_timestamp: datetime | None
    letter_entry_id: int | None
    letter_entry_title: str | None
    letter_written_at: datetime | None
    chapter_title: str | None
    chapter_stage_number: int | None
    included_in_title: str | None


def _all_promotions_query(user_id: int, status_filter: PromotionStatusFilter) -> Select[Any]:
    """Select the caller's quotes with each kind's live source and the (visible) review title.

    SQLAlchemy's own ``select`` rather than SQLModel's, which is typed for at most
    four columns; this reads nine.
    """
    return (
        select_columns(
            PromotedQuote,
            col(_Source.title),
            col(_Source.timestamp),
            col(_LetterEntry.id),
            col(_LetterEntry.title),
            col(Marginalia.essay_generated_at),
            col(StageContent.title),
            col(CourseStage.stage_number),
            col(_Target.title),
        )
        .outerjoin(
            _Source,
            and_(
                col(_Source.id) == col(PromotedQuote.source_entry_id),
                col(_Source.user_id) == user_id,
                col(_Source.deleted_at).is_(None),
            ),
        )
        .outerjoin(
            Marginalia,
            and_(
                col(Marginalia.id) == col(PromotedQuote.source_marginalia_id),
                col(Marginalia.user_id) == user_id,
            ),
        )
        .outerjoin(
            _LetterEntry,
            and_(
                col(_LetterEntry.id) == col(Marginalia.journal_entry_id),
                col(_LetterEntry.user_id) == user_id,
                col(_LetterEntry.deleted_at).is_(None),
            ),
        )
        # Shared curriculum: no account owns a chapter, so there is no user_id to scope.
        .outerjoin(StageContent, col(StageContent.id) == col(PromotedQuote.source_content_id))
        .outerjoin(CourseStage, col(CourseStage.id) == col(StageContent.course_stage_id))
        .outerjoin(
            _Target,
            and_(
                col(_Target.id) == col(PromotedQuote.included_in_entry_id),
                col(_Target.user_id) == user_id,
                col(_Target.deleted_at).is_(None),
            ),
        )
        .where(
            col(PromotedQuote.user_id) == user_id,
            _SOURCE_IS_LIVE,
            *_STATUS_PREDICATES[status_filter],
        )
    )


class _Provenance(NamedTuple):
    """Where a listed quote came from, as the list item states it."""

    title: str | None
    timestamp: datetime
    stage_number: int | None = None
    letter_entry_id: int | None = None


def _entry_provenance(row: _ListRow) -> _Provenance:
    """An entry quote is described by its source entry, as it always was."""
    # The WHERE lists an entry quote only when its source entry joined.
    return _Provenance(row.entry_title, cast("datetime", row.entry_timestamp))


def _course_provenance(row: _ListRow) -> _Provenance:
    """A Course quote names its live chapter, or the title it snapshotted once that is gone."""
    title = row.chapter_title if row.chapter_title is not None else row.quote.source_title
    return _Provenance(title, row.quote.created_at, stage_number=row.chapter_stage_number)


def _letter_provenance(row: _ListRow) -> _Provenance:
    """A letter quote names the entry its note sits on, timed by when the letter was written."""
    written_at = row.letter_written_at or row.quote.created_at
    return _Provenance(row.letter_entry_title, written_at, letter_entry_id=row.letter_entry_id)


_PROVENANCE: dict[PromotedQuoteSourceKind, Callable[[_ListRow], _Provenance]] = {
    PromotedQuoteSourceKind.ENTRY: _entry_provenance,
    PromotedQuoteSourceKind.COURSE: _course_provenance,
    PromotedQuoteSourceKind.LETTER: _letter_provenance,
}


def _list_item(row: _ListRow) -> PromotedQuoteListItemResponse:
    """Map one joined row to its user_id-free list item."""
    quote = row.quote
    provenance = _PROVENANCE[PromotedQuoteSourceKind(quote.source_kind)](row)
    return PromotedQuoteListItemResponse(
        **_quote_response(quote).model_dump(),
        source_title=provenance.title,
        source_timestamp=provenance.timestamp,
        source_stage_number=provenance.stage_number,
        letter_entry_id=provenance.letter_entry_id,
        included_in_entry_id=quote.included_in_entry_id,
        included_in_title=row.included_in_title,
        created_at=quote.created_at,
    )


@dataclass
class _ListAllParams:
    """Query parameters for ``GET /promotions``: a status filter and an offset page."""

    status: PromotionStatusFilter = PromotionStatusFilter.ALL
    limit: int = Query(default=DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE)
    offset: int = Query(default=0, ge=0, le=MAX_PAGE_OFFSET)


@router.get("/promotions", response_model=PromotedQuoteListResponse)
@limiter.limit(LIST_PROMOTIONS_RATE_LIMIT)
async def list_all_promotions(
    request: Request,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    params: Annotated[_ListAllParams, Depends()],
) -> PromotedQuoteListResponse:
    """List every quote the caller has promoted, from every kind of source, newest first.

    The route takes no id, so ownership rides on ``user_id`` predicates: on the
    quote, on each join onto the caller's own rows (the source entry, a letter's
    margin note and the entry it sits on), and on the inclusion-target join. A
    quote whose source entry -- or, for a letter quote, whose note's entry -- was
    soft-deleted is excluded; a Course quote is always listed; a quote folded
    into a review that was since deleted stays listed with ``included_in_title``
    null. Ordered by ``(created_at DESC, id DESC)`` so ties page stably.
    """
    query = _all_promotions_query(current_user, params.status)
    total = await count_query_total(session, query)
    page = await session.execute(
        query.order_by(col(PromotedQuote.created_at).desc(), col(PromotedQuote.id).desc())
        .offset(params.offset)
        .limit(params.limit)
    )
    # ``request`` is what ``@limiter.limit`` keys on; naming the path it served
    # keeps the read observable beside the write events above.
    logger.info(
        "promoted_quotes_listed",
        extra={
            "user_id": current_user,
            "status": params.status.value,
            "path": route_template(request),
        },
    )
    return PromotedQuoteListResponse(
        items=[_list_item(_ListRow(*row)) for row in page.all()],
        total=total,
        has_more=page_has_more(params.offset, params.limit, total),
    )
