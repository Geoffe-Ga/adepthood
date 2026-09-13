"""Database-backed exactly-once claims for explicit check-in deltas."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import date

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from errors import conflict
from models.goal_completion_idempotency import GoalCompletionSpend


@dataclass(frozen=True)
class GoalCompletionIntent:
    """Canonical identity of one explicit signed check-in mutation."""

    goal_id: int
    local_day: date
    completed_units: float


def _hash_key(user_id: int, raw_key: str) -> str:
    """Bound and namespace a caller's raw key without storing it."""
    return hashlib.sha256(f"{user_id}:{raw_key}".encode()).hexdigest()


async def _recorded_spend(
    session: AsyncSession,
    user_id: int,
    hashed_key: str,
) -> GoalCompletionSpend | None:
    """Return the durable receipt for a user's hashed key, when present."""
    result = await session.execute(
        select(GoalCompletionSpend).where(
            GoalCompletionSpend.user_id == user_id,
            col(GoalCompletionSpend.idem_key) == hashed_key,
        )
    )
    return result.scalars().first()


def _require_matching_intent(
    recorded: GoalCompletionSpend,
    intent: GoalCompletionIntent,
) -> None:
    """Reject accidental or adversarial reuse of a key for different work."""
    if (
        recorded.goal_id != intent.goal_id
        or recorded.local_day != intent.local_day
        or recorded.completed_units != intent.completed_units
    ):
        raise conflict("idempotency_key_reused")


async def claim_goal_completion_operation(
    session: AsyncSession,
    user_id: int,
    raw_key: str,
    intent: GoalCompletionIntent,
) -> bool:
    """Claim ``raw_key`` in the current transaction; return false for replay.

    The receipt is only durable when the caller commits its check-in arithmetic.
    A unique-key collision waits for the competing transaction and then resolves
    to its receipt, so the database—not a process-local mutex—owns cross-worker
    exactly-once behavior.
    """
    hashed_key = _hash_key(user_id, raw_key)
    existing = await _recorded_spend(session, user_id, hashed_key)
    if existing is not None:
        _require_matching_intent(existing, intent)
        return False

    try:
        # This must stay in the caller's outer transaction, not a SAVEPOINT-only
        # write, so the receipt can never become visible before its arithmetic.
        session.add(
            GoalCompletionSpend(
                user_id=user_id,
                idem_key=hashed_key,
                goal_id=intent.goal_id,
                local_day=intent.local_day,
                completed_units=intent.completed_units,
            )
        )
        await session.flush()
    except IntegrityError:
        # Arithmetic has not begun when the claim collides, so rolling back
        # cannot discard any of it. The rollback also ends the pre-winner read
        # snapshot before resolving the committed winner.
        await session.rollback()
        winner = await _recorded_spend(session, user_id, hashed_key)
        if winner is None:
            raise conflict("idempotency_in_flight") from None
        _require_matching_intent(winner, intent)
        return False
    return True
