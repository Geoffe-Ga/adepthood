"""Practice session API — log sessions linked to UserPractice selections."""

from __future__ import annotations

import hashlib
import logging
from datetime import UTC, datetime, timedelta
from typing import Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Header, Response, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, func, select

from database import get_session
from dependencies.ownership import require_owned_user_practice
from domain.practice_insights import build_insights
from errors import bad_request, forbidden, not_found
from models.practice import Practice
from models.practice_session import PracticeSession
from models.user_practice import UserPractice
from routers.auth import get_current_user
from schemas import Page, PaginationParams, build_page
from schemas.pagination import paginate_query
from schemas.practice import (
    PracticeInsightsResponse,
    PracticeSessionCreate,
    PracticeSessionResponse,
)
from services.users import get_user_timezone

# Window for the insights SQL fetch.  Slightly larger than the 8-week rollup
# (~56 days) so a session logged late in the oldest bucket still lands in
# the right week after timezone normalization.
_INSIGHTS_LOOKBACK_DAYS = 60

# ``Cache-Control`` for the insights endpoint: each client may cache for one
# minute so a chatty frontend doesn't hammer the DB while a user idles on
# the screen.  ``private`` keeps shared proxies from cross-pollinating
# per-user rollups.
_INSIGHTS_CACHE_CONTROL = "private, max-age=60"

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/practice-sessions", tags=["practice-sessions"])


async def _resolve_user_practice_for_session(
    session: AsyncSession,
    user_practice_id: int,
    current_user: int,
) -> UserPractice:
    """Fetch the target ``UserPractice`` and enforce the 404→403 split.

    Pulled out of :func:`create_session` because the body-parameter
    ownership check can't ride :func:`require_owned_user_practice`
    (FastAPI's DI cannot extract body fields into sub-deps).  Keeping
    the lookup here keeps the handler's branching shallow enough for
    xenon rank A while preserving the canonical 404-then-403 order the
    IDOR matrix test relies on.
    """
    user_practice = (
        (await session.execute(select(UserPractice).where(UserPractice.id == user_practice_id)))
        .scalars()
        .first()
    )
    if user_practice is None:
        raise not_found("user_practice")
    if user_practice.user_id != current_user:
        raise forbidden("forbidden")
    return user_practice


async def _resolve_practice_with_mode(
    session: AsyncSession,
    user_practice: UserPractice,
    payload: PracticeSessionCreate,
) -> Practice:
    """Load the catalog practice and validate the metadata discriminator.

    A 400 ``mode_metadata_mismatch`` is returned when the request's
    ``mode_metadata`` references a mode that disagrees with the resolved
    practice — distinct from a 422 schema failure: the union deserialized
    cleanly; the caller just targeted the wrong practice.
    """
    practice = (
        (await session.execute(select(Practice).where(Practice.id == user_practice.practice_id)))
        .scalars()
        .first()
    )
    if practice is None:
        # Defensive: a UserPractice row whose practice was deleted is a
        # data-integrity issue.  Surface as 404 so the client retries.
        raise not_found("practice")
    if payload.mode_metadata is not None and payload.mode_metadata.mode != practice.mode:
        raise bad_request("mode_metadata_mismatch")
    return practice


def _idempotency_cache_key(user_id: int, raw_key: str) -> str:
    """Return a stable, opaque hash for ``(user_id, raw_key)`` idempotency storage.

    The raw header value may be up to 256 chars of client-controlled text.
    Hashing it with SHA-256 (a) keeps the cache key bounded, (b) prevents
    a crafted key from escaping the per-user namespace via a collision
    across users, and (c) means the raw client token is never stored or
    logged -- same reasoning as the rate-limit key in ``practices.py``.
    The ``user:`` prefix keeps the key space disjoint from the raw hash
    space in any future backing store (Redis, DB column, …).
    """
    digest = hashlib.sha256(f"{user_id}:{raw_key}".encode()).hexdigest()
    return f"user:{digest}"


# Module-level in-process idempotency store.  Maps ``cache_key → session_id``
# for the lifetime of the process.  This is sufficient for a single-worker
# deployment; a multi-worker production deployment should replace this with a
# shared backing store (Redis, DB table) at the same interface.
# The store is intentionally not bounded -- sessions are small ints so memory
# growth is negligible for realistic request rates.
_IDEMPOTENCY_STORE: dict[str, int] = {}


@router.post(
    "/",
    response_model=PracticeSessionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_session(
    payload: PracticeSessionCreate,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> PracticeSession:
    """Log a practice session against a user-practice selection.

    Inline 404→403 split (rather than ``require_owned_user_practice``)
    because the ``user_practice_id`` arrives in the body, not as a path
    or query parameter — FastAPI's DI cannot extract body fields into
    sub-dependencies.  The ordering and exception types match the shared
    dep so the IDOR matrix test sees the same 403 for cross-user calls.

    Accepts an optional ``Idempotency-Key`` header (BUG-PRACTICE-007): if a
    key is present and a session was already created under the same
    ``(user_id, key)`` pair, the cached session row is returned without
    creating a duplicate.
    """
    # BUG-PRACTICE-007: idempotency check before any DB work.
    if idempotency_key is not None:
        cache_key = _idempotency_cache_key(current_user, idempotency_key)
        existing_id = _IDEMPOTENCY_STORE.get(cache_key)
        if existing_id is not None:
            existing = (
                (
                    await session.execute(
                        select(PracticeSession).where(PracticeSession.id == existing_id)
                    )
                )
                .scalars()
                .first()
            )
            if existing is not None:
                return existing

    user_practice = await _resolve_user_practice_for_session(
        session, payload.user_practice_id, current_user
    )
    practice = await _resolve_practice_with_mode(session, user_practice, payload)

    duration_minutes = payload.duration_minutes
    practice_session = PracticeSession(
        user_id=current_user,
        user_practice_id=payload.user_practice_id,
        duration_minutes=duration_minutes,
        reflection=payload.reflection,
        timestamp=payload.ended_at,
        mode=practice.mode,
        mode_metadata=(
            payload.mode_metadata.model_dump() if payload.mode_metadata is not None else None
        ),
        completed=payload.completed,
        insight=payload.insight,
    )
    session.add(practice_session)
    await session.commit()
    await session.refresh(practice_session)

    # Cache the new session id against the idempotency key so retries are deduplicated.
    if idempotency_key is not None and practice_session.id is not None:
        cache_key = _idempotency_cache_key(current_user, idempotency_key)
        _IDEMPOTENCY_STORE[cache_key] = practice_session.id

    logger.info(
        "practice_session_logged",
        extra={
            "user_id": current_user,
            "user_practice_id": payload.user_practice_id,
            "duration_minutes": duration_minutes,
            "mode": practice.mode,
            "completed": payload.completed,
        },
    )
    return practice_session


@router.get("/", response_model=None)
async def list_sessions(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    pagination: Annotated[PaginationParams, Depends()],
    user_practice: Annotated[UserPractice, Depends(require_owned_user_practice)],
) -> Page[PracticeSessionResponse] | list[PracticeSessionResponse]:
    """List sessions for a specific user-practice, newest first.

    Cross-user calls used to return an empty list (the ``user_id`` filter
    silently masked them); now ``require_owned_user_practice`` runs the
    canonical 404→403 split before we hit the sessions table so the
    auth-failure path is uniform with every other owned-resource route.

    BUG-INFRA-014: returns ``Page[PracticeSessionResponse]`` when
    ``?paginate=true`` is set; otherwise the legacy bare list is returned
    for one release while the frontend migrates to the envelope.
    """
    query = (
        select(PracticeSession)
        .where(
            PracticeSession.user_practice_id == user_practice.id,
            PracticeSession.user_id == current_user,
        )
        .order_by(col(PracticeSession.timestamp).desc())
    )
    items, total = await paginate_query(session, query, pagination)
    serialized = [PracticeSessionResponse.model_validate(s, from_attributes=True) for s in items]
    if pagination.paginate:
        return build_page(serialized, total, pagination)
    return serialized


@router.get("/insights", response_model=PracticeInsightsResponse)
async def get_insights(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    response: Response,
) -> PracticeInsightsResponse:
    """Return the mode-aware analytics rollup for the authenticated user.

    Single query fetches the last :data:`_INSIGHTS_LOOKBACK_DAYS` of the
    user's sessions; :func:`domain.practice_insights.build_insights` does
    the bucketing in memory (cheap — a heavy user accrues hundreds of
    rows in this window, not millions).

    The response carries a private one-minute ``Cache-Control`` so the
    frontend can poll the screen without thrashing the DB.
    """
    response.headers["Cache-Control"] = _INSIGHTS_CACHE_CONTROL
    # Defense-in-depth: a misconfigured upstream that ignores ``private``
    # still has the right cache key when ``Vary: Authorization`` is set,
    # so one user's rollup cannot leak to another sharing the proxy.
    response.headers["Vary"] = "Authorization"
    user_tz = await get_user_timezone(session, current_user)
    cutoff = datetime.now(UTC) - timedelta(days=_INSIGHTS_LOOKBACK_DAYS)
    rows = (
        (
            await session.execute(
                select(PracticeSession)
                .where(
                    PracticeSession.user_id == current_user,
                    PracticeSession.timestamp >= cutoff,
                )
                .order_by(col(PracticeSession.timestamp).desc())
            )
        )
        .scalars()
        .all()
    )
    insights = build_insights(rows, tz=user_tz)
    return PracticeInsightsResponse.model_validate(insights, from_attributes=True)


def _start_of_week_utc(tz_name: str) -> datetime:
    """Return the UTC-aware start-of-current-week boundary in the given timezone.

    BUG-PRACTICE-009: the legacy implementation computed ``start_of_week``
    using UTC midnight of the Monday in the *UTC* week.  Users east of UTC
    (e.g. UTC+9, Tokyo) saw their Sunday sessions land in the "next week"
    bucket; users west of UTC (e.g. UTC-8, California) saw their Monday
    sessions sometimes disappear if the UTC boundary had already crossed.

    The fix localises ``datetime.now()`` to the user's configured timezone
    (sourced from ``User.timezone``), finds that week's Monday at 00:00 local
    time, then converts back to a UTC-aware datetime so the SQL comparison is
    always apples-to-apples.  ``ZoneInfoNotFoundError`` is caught so a
    corrupted ``timezone`` value falls back to UTC rather than a 500 error.
    """
    try:
        tz = ZoneInfo(tz_name)
    except ZoneInfoNotFoundError:
        tz = ZoneInfo("UTC")
    now_local = datetime.now(tz)
    # Monday of the current local week at midnight.
    local_monday = now_local - timedelta(days=now_local.weekday())
    local_midnight = local_monday.replace(hour=0, minute=0, second=0, microsecond=0)
    # Return as a UTC-aware datetime for SQL comparison.
    return local_midnight.astimezone(UTC)


@router.get("/week-count")
async def week_count(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, int]:
    """Return the number of sessions the authenticated user completed this week.

    BUG-PRACTICE-009: the week boundary is derived from the user's stored
    ``timezone`` field (``User.timezone``) so a user in ``America/Los_Angeles``
    sees their Monday-through-Sunday window, not the UTC equivalent.
    """
    user_tz = await get_user_timezone(session, current_user)
    start_of_week = _start_of_week_utc(user_tz)
    statement = select(func.count()).where(
        PracticeSession.user_id == current_user,
        PracticeSession.timestamp >= start_of_week,
    )
    result = await session.execute(statement)
    count = result.scalar_one()
    return {"count": count}
