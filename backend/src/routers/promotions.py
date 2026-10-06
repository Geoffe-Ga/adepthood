"""Quote-promotion API — lift a span from one entry, optionally fold it into another.

Promoting a quote anchors a character span of a source journal entry; the server
slices and snapshots the text (the client sends only offsets) so the quote
survives later edits. A promotion can then be folded into a hierarchical
reflection or returned to pending. ``GET /promotions`` lists every quote the
caller has promoted, across entries, for the Promoted quotes screen (#2865).
``user_id`` is never returned.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any, cast

from fastapi import Depends, Query, Request, Response, status
from sqlalchemy import ColumnElement, and_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlalchemy.sql import Select
from sqlmodel import col, select

from bounds import MAX_PAGE_OFFSET, RowIdPath
from database import get_session
from dependencies.ownership import require_owned_journal_entry
from error_responses import build_router
from errors import not_found, unprocessable
from models.journal_entry import JournalEntry, JournalTag
from models.promoted_quote import PROMOTED_QUOTE_TEXT_MAX, PromotedQuote
from observability import route_template
from rate_limit import limiter
from routers.auth import get_current_user
from schemas.pagination import DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, count_query_total, page_has_more
from schemas.promotion import (
    PromotedQuoteListItemResponse,
    PromotedQuoteListResponse,
    PromotedQuoteResponse,
    PromoteQuoteCreate,
    PromotionStatusFilter,
    PromotionUpdate,
)
from security import TextTooLongError, sanitize_user_text

logger = logging.getLogger(__name__)

router = build_router(tags=["promotions"])

# A list read, limited like the journal list it sits beside (#2865).
LIST_PROMOTIONS_RATE_LIMIT = "30/minute"


def _quote_response(quote: PromotedQuote) -> PromotedQuoteResponse:
    """Map a promoted-quote row to its user_id-free response DTO."""
    return PromotedQuoteResponse(
        id=cast("int", quote.id),
        source_entry_id=quote.source_entry_id,
        anchor_start=quote.anchor_start,
        anchor_end=quote.anchor_end,
        anchor_text=quote.anchor_text,
        pending=quote.included_in_entry_id is None,
        stale=quote.stale,
    )


def _slice_anchor_text(entry: JournalEntry, payload: PromoteQuoteCreate) -> str:
    """Slice + sanitize the anchored span from the persisted body.

    Offsets are Unicode code points (Python string indexing is code-point-based),
    which is the anchor API's contract. The span is validated against the
    *server-held* body (never client text): an end past the body length is 422
    ``anchor_out_of_range``, and a normalized span longer than the plaintext cap
    is 422 ``quote_too_long``.
    """
    if payload.anchor_end > len(entry.message):
        raise unprocessable("anchor_out_of_range")
    span = entry.message[payload.anchor_start : payload.anchor_end]
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
    """
    anchor_text = _slice_anchor_text(entry, payload)
    quote = PromotedQuote(
        user_id=current_user,
        source_entry_id=cast("int", entry.id),
        anchor_start=payload.anchor_start,
        anchor_end=payload.anchor_end,
        anchor_text=anchor_text,
        included_in_entry_id=None,
    )
    session.add(quote)
    await session.commit()
    await session.refresh(quote)
    logger.info("quote_promoted", extra={"user_id": current_user, "quote_id": quote.id})
    return _quote_response(quote)


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
    """
    quote = await _load_owned_quote(session, promotion_id, current_user)
    if quote is None:
        raise not_found("promotion")
    if payload.included_in_entry_id is not None:
        await _validate_inclusion_target(session, payload.included_in_entry_id, current_user)
    quote.included_in_entry_id = payload.included_in_entry_id
    session.add(quote)
    await session.commit()
    await session.refresh(quote)
    logger.info(
        "quote_promotion_updated", extra={"user_id": current_user, "quote_id": promotion_id}
    )
    return _quote_response(quote)


# The two aliases keep the source and inclusion-target joins on ``journalentry``
# apart. Both are scoped to the caller and to live rows *in the join itself*:
# the source join is INNER so a quote whose source was deleted (or is somehow
# foreign) drops out of items and total alike, and the target join is OUTER so a
# deleted or foreign review hides only its title, never the quote.
_Source = aliased(JournalEntry, name="source_entry")
_Target = aliased(JournalEntry, name="included_entry")

_STATUS_PREDICATES: dict[PromotionStatusFilter, tuple[ColumnElement[bool], ...]] = {
    PromotionStatusFilter.PENDING: (col(PromotedQuote.included_in_entry_id).is_(None),),
    PromotionStatusFilter.INCLUDED: (col(PromotedQuote.included_in_entry_id).is_not(None),),
    PromotionStatusFilter.ALL: (),
}


def _all_promotions_query(user_id: int, status_filter: PromotionStatusFilter) -> Select[Any]:
    """Select the caller's quotes with their live source and (visible) review titles."""
    return (
        select(PromotedQuote, _Source.title, _Source.timestamp, _Target.title)
        .join(
            _Source,
            and_(
                col(_Source.id) == col(PromotedQuote.source_entry_id),
                col(_Source.user_id) == user_id,
                col(_Source.deleted_at).is_(None),
            ),
        )
        .outerjoin(
            _Target,
            and_(
                col(_Target.id) == col(PromotedQuote.included_in_entry_id),
                col(_Target.user_id) == user_id,
                col(_Target.deleted_at).is_(None),
            ),
        )
        .where(PromotedQuote.user_id == user_id, *_STATUS_PREDICATES[status_filter])
    )


def _list_item(
    quote: PromotedQuote,
    source_title: str | None,
    source_timestamp: datetime,
    included_in_title: str | None,
) -> PromotedQuoteListItemResponse:
    """Map one joined row to its user_id-free list item."""
    return PromotedQuoteListItemResponse(
        **_quote_response(quote).model_dump(),
        source_title=source_title,
        source_timestamp=source_timestamp,
        included_in_entry_id=quote.included_in_entry_id,
        included_in_title=included_in_title,
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
    """List every quote the caller has promoted, across entries, newest first.

    The route takes no id, so ownership rides on ``user_id`` predicates: on the
    quote, on the source join, and on the inclusion-target join. A quote whose
    source entry was soft-deleted is excluded; a quote folded into a review that
    was since deleted stays listed with ``included_in_title`` null. Ordered by
    ``(created_at DESC, id DESC)`` so ties page stably.
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
        items=[_list_item(*row) for row in page.all()],
        total=total,
        has_more=page_has_more(params.offset, params.limit, total),
    )
