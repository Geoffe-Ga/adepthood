"""DB-backed idempotency for practice-session creation.

The read/insert primitives for the ``PracticeSessionSpend`` table that backs the
``POST /practice-sessions`` ``Idempotency-Key`` dedup. Practice-session writes are
fast and synchronous (no slow LLM call), so there is no in-flight tombstone
window — the spend row is inserted in the same transaction as the session and
always carries a real ``session_id``. Cross-worker serialisation comes from the
``UNIQUE(user_id, idem_key)`` constraint, not a process-local lock.
"""

from __future__ import annotations

import hashlib

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.practice_session_idempotency import PracticeSessionSpend


def hash_idem_key(user_id: int, raw_key: str) -> str:
    """Return a stable SHA-256 hash of ``(user_id, raw_key)`` for the column value.

    The raw client header is never stored. Hashing keeps the column width
    bounded and one-way, and the ``user_id`` prefix keeps the hash space
    disjoint across users so a crafted key cannot collide into another user's
    namespace.
    """
    return hashlib.sha256(f"{user_id}:{raw_key}".encode()).hexdigest()


async def recorded_session_id(
    session: AsyncSession, user_id: int, raw_key: str | None
) -> int | None:
    """Return the ``session_id`` already recorded for this key, or ``None``."""
    if raw_key is None:
        return None
    hashed = hash_idem_key(user_id, raw_key)
    result = await session.execute(
        select(PracticeSessionSpend.session_id).where(
            PracticeSessionSpend.user_id == user_id,
            col(PracticeSessionSpend.idem_key) == hashed,
        )
    )
    return result.scalars().first()


async def record_session(
    session: AsyncSession, user_id: int, raw_key: str, session_id: int
) -> bool:
    """Insert the spend row, returning ``False`` on a duplicate-key collision.

    The INSERT is wrapped in a ``begin_nested()`` SAVEPOINT so a collision only
    rolls back this insert — any work already staged on the session (the
    just-flushed ``PracticeSession``) is left for the caller to roll back as a
    unit. ``False`` means another request already recorded this key; the caller
    re-reads it via :func:`recorded_session_id` and returns that session.
    """
    hashed = hash_idem_key(user_id, raw_key)
    try:
        async with session.begin_nested():
            session.add(
                PracticeSessionSpend(user_id=user_id, idem_key=hashed, session_id=session_id)
            )
            await session.flush()
    except IntegrityError:
        return False
    return True
