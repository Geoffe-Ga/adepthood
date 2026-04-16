"""Practices API — browse available practices and submit new ones."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from errors import not_found
from models.practice import Practice
from rate_limit import limiter
from routers.auth import get_current_user
from schemas.practice import PracticeCreate, PracticeResponse

router = APIRouter(prefix="/practices", tags=["practices"])


@router.get("/", response_model=list[PracticeResponse])
async def list_practices(
    stage_number: int,
    _current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> list[Practice]:
    """List approved practices for a given stage."""
    result = await session.execute(
        select(Practice).where(
            Practice.stage_number == stage_number,
            col(Practice.approved).is_(True),
        )
    )
    return list(result.scalars().all())


@router.get("/{practice_id}", response_model=PracticeResponse)
async def get_practice(
    practice_id: int,
    _current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> Practice:
    """Get a single practice with full instructions."""
    result = await session.execute(select(Practice).where(Practice.id == practice_id))
    practice = result.scalars().first()
    if practice is None or not practice.approved:
        raise not_found("practice")
    return practice


@router.post("/", response_model=PracticeResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
async def submit_practice(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    payload: PracticeCreate,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> Practice:
    """Submit a new user-created practice (defaults to unapproved)."""
    practice = Practice(
        **payload.model_dump(),
        submitted_by_user_id=current_user,
        approved=False,
    )
    session.add(practice)
    await session.commit()
    await session.refresh(practice)
    return practice
