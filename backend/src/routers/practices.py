"""Practices API — browse available practices and submit new ones."""

from __future__ import annotations

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from database import get_session
from errors import not_found
from models.practice import Practice
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
            Practice.approved == True,  # noqa: E712
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
    if practice is None:
        raise not_found("practice")
    return practice


@router.post("/", response_model=PracticeResponse, status_code=status.HTTP_201_CREATED)
async def submit_practice(
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
