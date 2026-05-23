"""Practices API — browse available practices and submit new ones."""

from __future__ import annotations

import logging
from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, Query, Request, status
from slowapi.util import get_remote_address
from sqlalchemy import or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from dependencies.ownership import require_visible_practice
from models.practice import Practice
from rate_limit import limiter
from routers.auth import extract_user_id_from_authorization, get_current_user
from schemas import Page, PaginationParams, build_page
from schemas.pagination import paginate_query
from schemas.practice import PracticeCreate, PracticeResponse


def _per_user_rate_limit_key(request: Request) -> str:
    """Rate-limit key derived from the JWT ``sub`` claim (BUG-PRACTICE-003).

    The default ``slowapi`` key is the remote address, which lets a
    single user rotate IPs to bypass the per-IP cap and, conversely,
    multiple legitimate users behind a shared NAT throttle each other.

    Keying on the JWT's ``sub`` (the stable user id) instead of a hash
    of the bearer token means a logout / refresh flow that mints a new
    token does NOT reset the user's rate-limit bucket -- the budget
    follows the identity, not the credential.  Decoding here costs one
    HMAC-SHA256 per request which is dominated by the LLM call below.

    Falls back to the remote address for malformed or missing tokens
    so the limiter never receives an empty key (and so any pre-auth
    probe is still throttled before FastAPI's DI rejects it).
    """
    try:
        return f"user:{extract_user_id_from_authorization(request.headers.get('authorization'))}"
    except Exception:  # noqa: BLE001 — fall through to IP for any decode failure
        return get_remote_address(request)


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/practices", tags=["practices"])


@router.get("/", response_model=None)
async def list_practices(
    stage_number: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    pagination: Annotated[PaginationParams, Depends()],
    *,
    include_mine: Annotated[bool, Query(description="Include the caller's own drafts.")] = False,
) -> Page[PracticeResponse] | list[PracticeResponse]:
    """List approved practices for a given stage.

    BUG-INFRA-012: returns ``Page[PracticeResponse]`` when ``?paginate=true``
    is set; otherwise the legacy bare list is returned for one release while
    the frontend migrates to the envelope.

    ``include_mine`` (custom-practices-07): when ``True``, also include
    unapproved drafts whose ``submitted_by_user_id`` matches the
    authenticated user. The default ``False`` preserves the existing
    "approved only" listing semantics so existing clients see no change;
    the catalog screen opts in so a user's own drafts appear under
    "My drafts" without leaking other users' submissions.
    """
    approved_clause = col(Practice.approved).is_(True)
    visibility = (
        or_(approved_clause, col(Practice.submitted_by_user_id) == current_user)
        if include_mine
        else approved_clause
    )
    query = select(Practice).where(
        Practice.stage_number == stage_number,
        visibility,
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
    # ``PracticeCreate._resolve_mode_and_config`` fills in both fields
    # during model validation, so they are guaranteed non-None on a
    # validated payload.  ``cast`` narrows the annotation without
    # introducing a runtime check the validator already guarantees.
    practice = Practice(
        stage_number=payload.stage_number,
        name=payload.name,
        description=payload.description,
        instructions=payload.instructions,
        default_duration_minutes=payload.default_duration_minutes,
        submitted_by_user_id=current_user,
        approved=False,
        mode=cast("str", payload.mode),
        mode_config=cast("dict[str, Any]", payload.mode_config),
    )
    session.add(practice)
    await session.commit()
    await session.refresh(practice)
    logger.info(
        "practice_submitted",
        extra={"user_id": current_user, "practice_id": practice.id},
    )
    return practice
