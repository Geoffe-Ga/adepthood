"""Journal API — chat messages, tagging, search, and pagination."""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import ColumnElement, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from errors import not_found
from models.journal_entry import JournalEntry, JournalTag
from routers.auth import get_current_user
from schemas.journal import (
    JournalBotMessageCreate,
    JournalListResponse,
    JournalMessageCreate,
    JournalMessageResponse,
)

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
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> JournalEntry:
    """Create a journal message for the authenticated user."""
    entry = JournalEntry(sender="user", user_id=current_user, **payload.model_dump())
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    return entry


def _build_filter_conditions(filters: _ListFilters) -> list[ColumnElement[bool]]:
    """Build SQLAlchemy where-clauses from the filter parameters."""
    conditions: list[ColumnElement[bool]] = []
    if filters.search is not None:
        conditions.append(col(JournalEntry.message).ilike(f"%{filters.search}%"))
    if filters.tag is not None:
        conditions.append(col(JournalEntry.tag) == filters.tag.value)
    if filters.practice_session_id is not None:
        conditions.append(col(JournalEntry.practice_session_id) == filters.practice_session_id)
    return conditions


@router.get("/", response_model=JournalListResponse)
async def list_journal_entries(
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
    filters: _ListFilters = Depends(),  # noqa: B008
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
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> JournalEntry:
    """Return a single journal entry by ID, scoped to the authenticated user."""
    entry = await session.get(JournalEntry, entry_id)
    if entry is None or entry.user_id != current_user:
        raise not_found("journal_entry")
    return entry


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_journal_entry(
    entry_id: int,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> Response:
    """Delete a journal entry. Returns 204 No Content on success."""
    entry = await session.get(JournalEntry, entry_id)
    if entry is None or entry.user_id != current_user:
        raise not_found("journal_entry")
    await session.delete(entry)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/bot-response",
    response_model=JournalMessageResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_bot_response(
    payload: JournalBotMessageCreate,
    _current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> JournalEntry:
    """Store a BotMason AI response (internal endpoint for AI integration layer)."""
    entry = JournalEntry(sender="bot", **payload.model_dump())
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    return entry
