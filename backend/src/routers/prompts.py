"""Weekly reflection prompts API — serve prompts and store responses."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from domain.weekly_prompts import TOTAL_WEEKS, get_prompt_for_week
from errors import bad_request, not_found
from models.journal_entry import JournalEntry, JournalTag
from models.prompt_response import PromptResponse
from models.stage_progress import StageProgress
from models.user import User
from routers.auth import get_current_user
from schemas.prompt import PromptDetail, PromptListResponse, PromptSubmit

router = APIRouter(prefix="/prompts", tags=["prompts"])

_DAYS_PER_WEEK = 7


async def _get_user_week(session: AsyncSession, user_id: int) -> int:
    """Derive the user's current week number from their program start date.

    Uses StageProgress.stage_started_at if available, otherwise falls back
    to User.created_at. The result is clamped to [1, TOTAL_WEEKS].
    """
    result = await session.execute(select(StageProgress).where(StageProgress.user_id == user_id))
    progress = result.scalars().first()

    if progress is not None:
        start_date = progress.stage_started_at
    else:
        user = await session.get(User, user_id)
        start_date = user.created_at if user else datetime.now(UTC)

    now = datetime.now(UTC)
    # SQLite returns naive datetimes; ensure both sides match for subtraction
    if start_date.tzinfo is None:
        start_date = start_date.replace(tzinfo=UTC)
    elapsed = now - start_date
    week = int(elapsed / timedelta(days=_DAYS_PER_WEEK)) + 1
    return max(1, min(week, TOTAL_WEEKS))


@router.get("/current", response_model=PromptDetail)
async def get_current_prompt(
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
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
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
    filters: _HistoryFilters = Depends(),  # noqa: B008
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
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
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
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
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

    await session.commit()
    await session.refresh(prompt_response)

    return PromptDetail(
        week_number=prompt_response.week_number,
        question=prompt_response.question,
        has_responded=True,
        response=prompt_response.response,
        timestamp=prompt_response.timestamp,
    )
