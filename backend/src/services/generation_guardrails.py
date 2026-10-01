"""Per-user generation guardrails: the minute bucket and the concurrent slot (#623).

The owner ratified, on 2026-09-05 (decision record §1,
``prompts/claude-comms/2026-09-05-resonance-economy-decision.md``):

    enforce generation limits per authenticated user, not only per IP;
    maximum **5 LLM generations/minute/user**;
    maximum **2 concurrent generations/user**;

The third guardrail from the same line, the "configurable launch ceiling of
**100 charged generations/day/user**", lives in
:func:`services.wallet.preflight_deduction`, the one chokepoint every charged
generation spends through.

**The minute bucket** (resonance and essay only -- record §4 scopes it to "the
resonance and essay routes"; transcription keeps its own 20/minute budget,
because one capture session fans out to about ten page calls). It is charged
inside the handler at the point a generation is about to happen, never by a
route decorator, so a cached essay reopen, an intimate entry, a 404 or a 409
price gate never spends it. A route peeks with
:func:`require_generation_minute_available` at admission (a cheap 429 before
any slot or charge) and takes the atomic hit with
:func:`consume_generation_minute` after payment is staged, so a 402 or a daily
429 never consumes it either. It rides the application limiter's in-process
storage, so like every other limit in DEPLOYMENT.md it is **per worker**
(``WEB_CONCURRENCY`` x 5 across a deployment), and it honours the limiter's
kill switch. BYOK generations spend it too: it is a generation limit, not a
charge limit.

**The concurrent slot** (resonance, essay and transcription, BYOK included).
A per-worker semaphore would admit ``WEB_CONCURRENCY`` x 2, double the
ratified number at the default of two workers, so the slot is a lease row in
``generationslot`` with ``UNIQUE(user_id, slot)``: cross-worker by
construction. It is taken before any charge, so a refusal never charges, and
released on every exit. It ignores the limiter kill switch, because it is a
cost guard rather than a throttle, and it fails closed: an error reading or
writing the lease table refuses the generation with a 503.
"""

from __future__ import annotations

import logging
import math
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import cast

from fastapi import HTTPException
from limits import RateLimitItemPerMinute
from limits.strategies import MovingWindowRateLimiter
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col

from errors import service_unavailable, too_many_requests
from models.generation_slot import GenerationSlot
from rate_limit import (
    RATE_LIMIT_EXCEEDED_DETAIL,
    limiter,
    rate_limiting_enabled,
    user_throttle_key,
)
from services.botmason import LLM_TIMEOUT_SECONDS, WORST_CASE_DIAL_SECONDS
from services.creek_vault_client import VAULT_TOTAL_DEADLINE_SECONDS

logger = logging.getLogger(__name__)

# Decision record §1: "maximum 5 LLM generations/minute/user".
GENERATIONS_PER_MINUTE_PER_USER = 5
GENERATION_USER_LIMIT_ITEM = RateLimitItemPerMinute(GENERATIONS_PER_MINUTE_PER_USER)
# Namespaces the bucket inside the shared limiter storage, apart from any
# route's own per-user bucket under the same ``user:<id>`` key.
_GENERATION_BUCKET_SCOPE = "generation"

# Decision record §1: "maximum 2 concurrent generations/user".
MAX_CONCURRENT_GENERATIONS_PER_USER = 2

# The most provider dials one generation can make: a resonance pass, its
# corrective second pass, and completion detection.
GENERATION_DIALS_PER_PASS = 3
# How long a lease lives before another request may reclaim it. Only a crashed
# worker's lease ever reaches it, because a live one is deleted when its
# generation ends; it is sized so no live generation's dials can outlast it.
GENERATION_SLOT_TTL_SECONDS = max(
    WORST_CASE_DIAL_SECONDS * GENERATION_DIALS_PER_PASS, VAULT_TOTAL_DEADLINE_SECONDS
)
# The server cannot know when the generation already in flight will finish, so
# it advertises one provider-call timeout: the honest "try again shortly".
GENERATION_IN_PROGRESS_RETRY_AFTER_SECONDS = int(LLM_TIMEOUT_SECONDS)

# 429 detail: two of this user's generations are already in flight.
GENERATION_IN_PROGRESS = "generation_in_progress"
# 503 detail: the lease table could not be read or written, so nothing is admitted.
GENERATION_GUARD_UNAVAILABLE = "generation_guard_unavailable"


def _minute_window() -> MovingWindowRateLimiter:
    """A moving window over the application limiter's own storage.

    Moving rather than fixed, so no 60-second span ever holds a sixth
    generation (a fixed window admits ten across a minute boundary). Sharing
    the limiter's storage means ``limiter.reset()`` clears it with every other
    bucket.
    """
    return MovingWindowRateLimiter(limiter.limiter.storage)


def _bucket(user_id: int) -> tuple[str, str]:
    return user_throttle_key(user_id), _GENERATION_BUCKET_SCOPE


def _minute_refusal(window: MovingWindowRateLimiter, user_id: int) -> HTTPException:
    """Build the per-minute 429 with the whole seconds until the bucket next admits.

    Rounded up and floored at one second, as the limiter's own envelope is:
    ``Retry-After: 0`` would read as "retry immediately".
    """
    stats = window.get_window_stats(GENERATION_USER_LIMIT_ITEM, *_bucket(user_id))
    retry_after = max(1, math.ceil(stats.reset_time - time.time()))
    return too_many_requests(RATE_LIMIT_EXCEEDED_DETAIL, retry_after)


def require_generation_minute_available(user_id: int) -> None:
    """Refuse with 429 when ``user_id`` has spent this minute's generations; spend nothing."""
    if not rate_limiting_enabled():
        return
    window = _minute_window()
    if not window.test(GENERATION_USER_LIMIT_ITEM, *_bucket(user_id)):
        raise _minute_refusal(window, user_id)


def consume_generation_minute(user_id: int) -> None:
    """Spend one of ``user_id``'s generations this minute, or refuse with 429.

    The hit is atomic (one call into the limiter storage), so two concurrent
    requests at four of five cannot both be admitted on this worker.
    """
    if not rate_limiting_enabled():
        return
    window = _minute_window()
    if not window.hit(GENERATION_USER_LIMIT_ITEM, *_bucket(user_id)):
        raise _minute_refusal(window, user_id)


def open_lease_session(session: AsyncSession) -> AsyncSession:
    """Open a sibling session on the request session's engine, for lease writes.

    The lease commits in its own short transaction so the route's later
    ``commit()`` / ``rollback()`` can neither drop it nor carry it -- the
    same pattern the vault pipeline uses for its off-request work.
    """
    if session.bind is None:
        msg = "generation_slot needs a bound session"
        raise RuntimeError(msg)
    return async_sessionmaker(session.bind, class_=AsyncSession, expire_on_commit=False)()


async def _try_insert(lease_session: AsyncSession, lease: GenerationSlot) -> bool:
    """Insert ``lease`` under a savepoint; ``False`` when its slot is already held."""
    try:
        async with lease_session.begin_nested():
            lease_session.add(lease)
    except IntegrityError:
        return False
    return True


async def _acquire(session: AsyncSession, user_id: int) -> int:
    """Take one of the user's free slots and return the lease id, or refuse.

    Expired leases are purged first, then each slot is tried in turn; the
    unique ``(user_id, slot)`` pair is what refuses a slot another worker
    holds. Raises 429 ``generation_in_progress`` when every slot is held and
    503 ``generation_guard_unavailable`` on any other database error.
    """
    now = datetime.now(UTC)
    expires_at = now + timedelta(seconds=GENERATION_SLOT_TTL_SECONDS)
    try:
        async with open_lease_session(session) as lease_session:
            await lease_session.execute(
                delete(GenerationSlot).where(
                    col(GenerationSlot.user_id) == user_id,
                    col(GenerationSlot.expires_at) < now,
                )
            )
            for slot in range(MAX_CONCURRENT_GENERATIONS_PER_USER):
                lease = GenerationSlot(
                    user_id=user_id, slot=slot, acquired_at=now, expires_at=expires_at
                )
                if await _try_insert(lease_session, lease):
                    await lease_session.commit()
                    # The savepoint flushed the insert, so the id is assigned.
                    return cast("int", lease.id)
            await lease_session.commit()
    except SQLAlchemyError as exc:
        logger.exception("generation_slot_acquire_failed", extra={"user_id": user_id})
        raise service_unavailable(GENERATION_GUARD_UNAVAILABLE) from exc
    raise too_many_requests(GENERATION_IN_PROGRESS, GENERATION_IN_PROGRESS_RETRY_AFTER_SECONDS)


async def _release(session: AsyncSession, lease_id: int, user_id: int) -> None:
    """Delete the lease; a failure is logged and left to the TTL, never raised."""
    try:
        async with open_lease_session(session) as lease_session:
            await lease_session.execute(
                delete(GenerationSlot).where(col(GenerationSlot.id) == lease_id)
            )
            await lease_session.commit()
    except SQLAlchemyError:
        logger.exception(
            "generation_slot_release_failed", extra={"user_id": user_id, "lease_id": lease_id}
        )


@asynccontextmanager
async def generation_slot(session: AsyncSession, user_id: int) -> AsyncIterator[None]:
    """Hold one of ``user_id``'s concurrent generation slots for the body.

    Acquire before any charge; release on every exit. On an exception exit the
    request session is rolled back *before* the release -- the rollback
    :func:`database.get_session` performs a moment later anyway, moved earlier
    so the release never waits behind, or commits, the route's own uncommitted
    writes. A normal exit rolls nothing back: the route has already committed,
    and expiring what it loaded would break the response it is building.
    """
    lease_id = await _acquire(session, user_id)
    try:
        yield
    except BaseException:
        await session.rollback()
        raise
    finally:
        await _release(session, lease_id, user_id)
