"""Practices API — browse available practices and submit new ones."""

from __future__ import annotations

import hashlib
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Request, status
from slowapi.util import get_remote_address
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select
from starlette.requests import Request as StarletteRequest

from database import get_session
from dependencies.ownership import require_visible_practice
from models.practice import Practice
from rate_limit import limiter
from routers.auth import get_current_user
from schemas import Page, PaginationParams, build_page
from schemas.pagination import paginate_query
from schemas.practice import PracticeCreate, PracticeResponse


def _per_user_rate_limit_key(request: StarletteRequest) -> str:
    """Rate-limit key that prefers a hash of the auth token over IP (BUG-PRACTICE-003).

    The default ``slowapi`` key is the remote address, which means a single
    user can rotate IPs to bypass the per-IP cap and, conversely, multiple
    legitimate users behind a shared NAT throttle each other.  Hashing the
    bearer token keeps the limiter keyed to the spending identity without
    storing a live JWT in the limiter's backing store -- the same shape used
    by :func:`routers.botmason._per_user_key`.
    """
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        digest = hashlib.sha256(auth_header.encode("utf-8")).hexdigest()
        return f"user:{digest}"
    return get_remote_address(request)


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/practices", tags=["practices"])


@router.get("/", response_model=None)
async def list_practices(
    stage_number: int,
    _current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    pagination: Annotated[PaginationParams, Depends()],
) -> Page[PracticeResponse] | list[PracticeResponse]:
    """List approved practices for a given stage.

    BUG-INFRA-012: returns ``Page[PracticeResponse]`` when ``?paginate=true``
    is set; otherwise the legacy bare list is returned for one release while
    the frontend migrates to the envelope.
    """
    query = select(Practice).where(
        Practice.stage_number == stage_number,
        col(Practice.approved).is_(True),
    )
    items, total = await paginate_query(session, query, pagination)
    serialized = [PracticeResponse.model_validate(p, from_attributes=True) for p in items]
    if pagination.paginate:
        return build_page(serialized, total, pagination)
    return serialized


@router.get("/{practice_id}", response_model=PracticeResponse)
async def get_practice(
    practice: Annotated[Practice, Depends(require_visible_practice)],
) -> Practice:
    """Get a single practice with full instructions.

    Visibility is approved-OR-submitter (BUG-PRACTICE-001): a draft is
    only readable to the user who submitted it; everyone else gets 403.
    Missing rows still 404.
    """
    return practice


@router.post("/", response_model=PracticeResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute", key_func=_per_user_rate_limit_key)
async def submit_practice(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    payload: PracticeCreate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Practice:
    """Submit a new user-created practice (defaults to unapproved).

    Constructed with explicit kwargs (BUG-PRACTICE-002) rather than
    ``**payload.model_dump()``: a future addition to ``PracticeCreate``
    that overlapped a server-controlled column (e.g. ``approved``,
    ``submitted_by_user_id``) would otherwise silently flow through to
    the ORM and let a client mint pre-approved rows or impersonate
    another submitter.  Listing the fields here makes the trust boundary
    visible and turns any new client-controlled field into a deliberate
    audit decision.
    """
    practice = Practice(
        stage_number=payload.stage_number,
        name=payload.name,
        description=payload.description,
        instructions=payload.instructions,
        default_duration_minutes=payload.default_duration_minutes,
        submitted_by_user_id=current_user,
        approved=False,
    )
    session.add(practice)
    await session.commit()
    await session.refresh(practice)
    logger.info(
        "practice_submitted",
        extra={"user_id": current_user, "practice_id": practice.id},
    )
    return practice
