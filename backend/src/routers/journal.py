"""Journal API — chat messages, tagging, search, and pagination."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response, status
from sqlalchemy import ColumnElement, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from errors import not_found, unprocessable
from models.journal_entry import JournalEntry, JournalTag
from rate_limit import limiter
from routers.auth import get_current_user
from schemas.journal import (
    JOURNAL_MESSAGE_MAX_LENGTH,
    JournalBotMessageCreate,
    JournalListResponse,
    JournalMessageCreate,
    JournalMessageResponse,
)
from security import TextTooLongError, sanitize_user_text


def _sanitize_message(message: str) -> str:
    """Apply :func:`sanitize_user_text` and translate overflow to HTTP 422.

    Pydantic's ``max_length`` already caps raw input at
    :data:`JOURNAL_MESSAGE_MAX_LENGTH`, but NFC normalization can in rare
    cases (Hangul jamo, Tibetan stacks) leave the post-normalization length
    *above* the cap.  Re-checking after sanitization closes that gap; we
    raise 422 (rather than the 500 we would otherwise return on an
    unhandled domain error) so the client sees a uniform length-violation
    shape regardless of which layer rejected the value.
    """
    try:
        return sanitize_user_text(message, max_len=JOURNAL_MESSAGE_MAX_LENGTH)
    except TextTooLongError as exc:
        raise unprocessable("message_too_long") from exc


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/journal", tags=["journal"])


@dataclass
class _ListFilters:
    """Query parameters for listing journal entries."""

    search: str | None = Query(default=None)
    tag: JournalTag | None = None
    practice_session_id: int | None = Query(default=None)
    limit: int = Query(default=50, ge=1, le=200)
    offset: int = Query(default=0, ge=0)


@router.post("/", response_model=JournalMessageResponse, status_code=status.HTTP_201_CREATED)
async def create_journal_entry(
    payload: JournalMessageCreate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> JournalEntry:
    """Create a journal message for the authenticated user.

    The message body is sanitized at the router boundary
    (BUG-JOURNAL-003) so the row that lands in the DB has no control
    characters, zero-width, or bidi-override codepoints — defense
    against stored-XSS payloads in journal renderers and Trojan-Source
    smuggling in log viewers.
    """
    data = payload.model_dump()
    data["message"] = _sanitize_message(data["message"])
    entry = JournalEntry(sender="user", user_id=current_user, **data)
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    logger.info("journal_entry_created", extra={"user_id": current_user, "entry_id": entry.id})
    return entry


def _escape_like(value: str) -> str:
    r"""Escape SQL LIKE wildcards so literal ``%``, ``_``, ``\\`` are matched.

    Uses ``\\`` as the escape character, which must be declared via
    ``escape="\\\\"`` on the ``.ilike()`` call (BUG-JOURNAL-013).
    """
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _build_filter_conditions(filters: _ListFilters) -> list[ColumnElement[bool]]:
    """Build SQLAlchemy where-clauses from the filter parameters."""
    conditions: list[ColumnElement[bool]] = []
    if filters.search is not None:
        escaped = _escape_like(filters.search)
        conditions.append(col(JournalEntry.message).ilike(f"%{escaped}%", escape="\\"))
    if filters.tag is not None:
        conditions.append(col(JournalEntry.tag) == filters.tag.value)
    if filters.practice_session_id is not None:
        conditions.append(col(JournalEntry.practice_session_id) == filters.practice_session_id)
    return conditions


@router.get("/", response_model=JournalListResponse)
@limiter.limit("30/minute")
async def list_journal_entries(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    filters: Annotated[_ListFilters, Depends()],
) -> JournalListResponse:
    """List journal entries for the current user with optional filtering."""
    conditions = _build_filter_conditions(filters)
    query = select(JournalEntry).where(JournalEntry.user_id == current_user, *conditions)

    # Count total before pagination
    count_query = select(func.count()).select_from(query.subquery())
    total = (await session.execute(count_query)).scalar() or 0

    # Fetch paginated results, newest first
    query = query.order_by(col(JournalEntry.id).desc()).offset(filters.offset).limit(filters.limit)
    result = await session.execute(query)
    items = list(result.scalars().all())

    return JournalListResponse(
        items=[JournalMessageResponse.model_validate(e, from_attributes=True) for e in items],
        total=total,
        has_more=(filters.offset + filters.limit) < total,
    )


@router.get("/{entry_id}", response_model=JournalMessageResponse)
async def get_journal_entry(
    entry_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> JournalEntry:
    """Return a single journal entry by ID, scoped to the authenticated user."""
    entry = await session.get(JournalEntry, entry_id)
    if entry is None or entry.user_id != current_user:
        raise not_found("journal_entry")
    return entry


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_journal_entry(
    entry_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Response:
    """Delete a journal entry. Returns 204 No Content on success."""
    entry = await session.get(JournalEntry, entry_id)
    if entry is None or entry.user_id != current_user:
        raise not_found("journal_entry")
    await session.delete(entry)
    await session.commit()
    logger.info("journal_entry_deleted", extra={"user_id": current_user, "entry_id": entry_id})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/bot-response",
    response_model=JournalMessageResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_bot_response(
    payload: JournalBotMessageCreate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> JournalEntry:
    """Store a BotMason AI response (internal endpoint for AI integration layer).

    ``user_id`` is sourced from the authenticated user — never from the request
    body — to prevent cross-user injection (BUG-JOURNAL-002).

    The bot message is also passed through :func:`sanitize_user_text`
    (BUG-JOURNAL-003 / BUG-BM-004): a model-generated reflection of an
    attacker's prompt-injection attempt could otherwise reintroduce control
    characters or bidi overrides into the journal stream.
    """
    data = payload.model_dump()
    data["message"] = _sanitize_message(data["message"])
    entry = JournalEntry(sender="bot", user_id=current_user, **data)
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    logger.info(
        "journal_bot_response_created", extra={"user_id": current_user, "entry_id": entry.id}
    )
    return entry
