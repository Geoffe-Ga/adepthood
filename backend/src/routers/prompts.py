"""Weekly reflection prompts API — serve prompts and store responses."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from domain.weekly_prompts import TOTAL_WEEKS, get_prompt_for_week
from errors import bad_request, conflict, not_found
from models.journal_entry import JournalEntry, JournalTag
from models.prompt_response import PromptResponse
from routers.auth import get_current_user
from schemas.prompt import PromptDetail, PromptListResponse, PromptSubmit

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/prompts", tags=["prompts"])


async def _get_user_week(session: AsyncSession, user_id: int) -> int:
    """Derive the user's current week from their last completed prompt.

    Returns ``max(PromptResponse.week_number) + 1`` so users advance only
    by completing prompts, not by waiting.  Falls back to week 1 when no
    responses exist yet.  The result is clamped to [1, TOTAL_WEEKS]
    (BUG-JOURNAL-014).
    """
    result = await session.execute(
        select(func.max(PromptResponse.week_number)).where(PromptResponse.user_id == user_id)
    )
    max_week = result.scalar()
    week = int(max_week) + 1 if max_week is not None else 1
    return int(max(1, min(week, TOTAL_WEEKS)))


@router.get("/current", response_model=PromptDetail)
async def get_current_prompt(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PromptDetail:
    """Return the prompt for the user's current week in the program."""
    week = await _get_user_week(session, current_user)
    question = get_prompt_for_week(week)
    if question is None:
        raise not_found("prompt")

    # Check if user already responded this week
    result = await session.execute(
        select(PromptResponse).where(
            PromptResponse.user_id == current_user,
            PromptResponse.week_number == week,
        )
    )
    existing = result.scalars().first()

    return PromptDetail(
        week_number=week,
        question=question,
        has_responded=existing is not None,
        response=existing.response if existing else None,
        timestamp=existing.timestamp if existing else None,
    )


@dataclass
class _HistoryFilters:
    """Query parameters for prompt history pagination."""

    limit: int = Query(default=50, ge=1, le=200)
    offset: int = Query(default=0, ge=0)


@router.get("/history", response_model=PromptListResponse)
async def list_prompt_history(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    filters: Annotated[_HistoryFilters, Depends()],
) -> PromptListResponse:
    """List all past prompts and responses for the user, paginated."""
    query = (
        select(PromptResponse)
        .where(PromptResponse.user_id == current_user)
        .order_by(col(PromptResponse.week_number).desc())
    )

    count_query = select(func.count()).select_from(query.subquery())
    total = (await session.execute(count_query)).scalar() or 0

    query = query.offset(filters.offset).limit(filters.limit)
    result = await session.execute(query)
    items = list(result.scalars().all())

    return PromptListResponse(
        items=[
            PromptDetail(
                week_number=pr.week_number,
                question=pr.question,
                has_responded=True,
                response=pr.response,
                timestamp=pr.timestamp,
            )
            for pr in items
        ],
        total=total,
        has_more=(filters.offset + filters.limit) < total,
    )


@router.get("/{week_number}", response_model=PromptDetail)
async def get_prompt_by_week(
    week_number: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PromptDetail:
    """Get a specific week's prompt and the user's response (if any)."""
    question = get_prompt_for_week(week_number)
    if question is None:
        raise not_found("prompt")

    result = await session.execute(
        select(PromptResponse).where(
            PromptResponse.user_id == current_user,
            PromptResponse.week_number == week_number,
        )
    )
    existing = result.scalars().first()

    return PromptDetail(
        week_number=week_number,
        question=question,
        has_responded=existing is not None,
        response=existing.response if existing else None,
        timestamp=existing.timestamp if existing else None,
    )


@router.post(
    "/{week_number}/respond",
    response_model=PromptDetail,
    status_code=status.HTTP_201_CREATED,
)
async def submit_prompt_response(
    week_number: int,
    payload: PromptSubmit,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PromptDetail:
    """Submit a response to a weekly prompt. Prevents duplicate responses."""
    question = get_prompt_for_week(week_number)
    if question is None:
        raise not_found("prompt")

    # Prevent duplicate responses
    result = await session.execute(
        select(PromptResponse).where(
            PromptResponse.user_id == current_user,
            PromptResponse.week_number == week_number,
        )
    )
    if result.scalars().first() is not None:
        raise bad_request("already_responded")

    # Create the prompt response
    prompt_response = PromptResponse(
        week_number=week_number,
        question=question,
        response=payload.response,
        user_id=current_user,
    )
    session.add(prompt_response)

    # Also create a journal entry so the response appears in journal history
    journal_entry = JournalEntry(
        message=payload.response,
        sender="user",
        user_id=current_user,
        tag=JournalTag.STAGE_REFLECTION,
    )
    session.add(journal_entry)

    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise conflict("already_responded") from None

    await session.refresh(prompt_response)

    logger.info(
        "prompt_response_submitted",
        extra={"user_id": current_user, "week_number": week_number},
    )

    return PromptDetail(
        week_number=prompt_response.week_number,
        question=prompt_response.question,
        has_responded=True,
        response=prompt_response.response,
        timestamp=prompt_response.timestamp,
    )
