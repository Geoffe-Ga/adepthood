"""Quote-promotion API — lift a span from one entry, optionally fold it into another.

Promoting a quote anchors a character span of a source journal entry; the server
slices and snapshots the text (the client sends only offsets) so the quote
survives later edits. A promotion can then be folded into a hierarchical
reflection or returned to pending. ``user_id`` is never returned.
"""

from __future__ import annotations

import logging
from typing import Annotated, cast

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from dependencies.ownership import require_owned_journal_entry
from errors import not_found, unprocessable
from models.journal_entry import JournalEntry, JournalTag
from models.promoted_quote import PROMOTED_QUOTE_TEXT_MAX, PromotedQuote
from routers.auth import get_current_user
from schemas.promotion import PromotedQuoteResponse, PromoteQuoteCreate, PromotionUpdate
from security import TextTooLongError, sanitize_user_text

logger = logging.getLogger(__name__)

router = APIRouter(tags=["promotions"])


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

    The span is validated against the *server-held* body (never client text): an
    end past the body length is 422 ``anchor_out_of_range``, and a normalized
    span longer than the plaintext cap is 422 ``quote_too_long``.
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
    promotion_id: int,
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
    promotion_id: int,
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
