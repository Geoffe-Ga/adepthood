"""Idempotency helpers for the BotMason chat endpoints (BUG-BM-012).

Both ``POST /journal/chat`` and ``POST /journal/chat/stream`` accept an
``Idempotency-Key`` header.  The helpers here are the read/insert/update
primitives for the ``ChatSpend`` table that backs the dedup guarantee.

Why this module exists (not inlined in either router or service):
the non-streaming router needs all three primitives, the streaming
service (``services/chat_stream.py``) needs ``_update_idem_result`` after
``finalise_stream_commit`` succeeds, and pulling the helpers up here
keeps the cross-layer dependency one-way (service → service, not
service → router).
"""

from __future__ import annotations

import hashlib
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.chat_spend import ChatSpend

logger = logging.getLogger(__name__)

# How long an in-flight tombstone (``result_json IS NULL``) may live before
# a colliding retry evicts it (issue #320).  Without eviction, a server
# crash between the tombstone insert and ``update_idem_result`` strands the
# row forever and every retry with the same key 409s permanently.  LLM
# calls can legitimately run 30+ seconds; 15 minutes sits far above any
# provider's p99 so a genuinely-running request is never evicted.
IN_FLIGHT_TTL = timedelta(minutes=15)


def hash_idem_key(user_id: int, raw_key: str) -> str:
    """Return a stable SHA-256 hash of ``(user_id, raw_key)`` for the column value.

    The raw client header is never stored.  Hashing keeps the column width
    bounded and one-way so a DB read cannot reveal the original key, and
    the ``user_id`` prefix keeps the hash space disjoint across users so a
    crafted key cannot collide into someone else's namespace.
    """
    return hashlib.sha256(f"{user_id}:{raw_key}".encode()).hexdigest()


async def check_idempotency(
    session: AsyncSession,
    user_id: int,
    raw_key: str | None,
) -> str | None:
    """Return the cached ``result_json`` if this key was already spent.

    Returns ``None`` when the key is unseen OR when a tombstone exists but
    its ``result_json`` is NULL (in-flight).  The two states look identical
    from the caller's side: both prompt the caller to try inserting a
    tombstone, and the second insert's ``IntegrityError`` is what reveals
    "another request is in-flight" — see :func:`insert_idem_tombstone`.
    """
    if raw_key is None:
        return None
    hashed = hash_idem_key(user_id, raw_key)
    result = await session.execute(
        select(ChatSpend).where(
            ChatSpend.user_id == user_id,
            col(ChatSpend.idem_key) == hashed,
        )
    )
    row = result.scalars().first()
    if row is None:
        return None
    return row.result_json


async def insert_idem_tombstone(
    session: AsyncSession,
    user_id: int,
    raw_key: str,
) -> bool:
    """Insert an in-flight ``ChatSpend`` row, returning ``False`` on duplicate.

    A ``False`` return means another request with the same key is already
    in flight (or has completed) — the caller should surface 409 to the
    client, or for a streaming endpoint, refuse to open the stream.

    The INSERT is wrapped in a ``begin_nested()`` SAVEPOINT so a collision
    only rolls back the tombstone attempt — any work already staged on the
    session by the caller survives.  The prior implementation called the
    bare ``session.rollback()``, which discarded the whole session and
    would have silently lost other pending changes if a future caller
    staged work before the tombstone insert.  Today's call sites are safe
    (the tombstone insert is the first DB mutation in each flow) but the
    savepoint removes the footgun.
    """
    hashed = hash_idem_key(user_id, raw_key)
    for attempt in (0, 1):
        try:
            async with session.begin_nested():
                session.add(ChatSpend(user_id=user_id, idem_key=hashed))
                await session.flush()
        except IntegrityError:
            # Issue #320: a collision against a crash-stranded tombstone
            # (NULL result, older than the TTL) self-heals — evict it and
            # retry the insert ONCE.  If two retries race here, both may
            # evict but the UNIQUE constraint still serialises the
            # re-insert: one wins, the other lands back in this branch on
            # its second attempt and returns False (409).
            if attempt == 0 and await _evict_expired_tombstone(session, user_id, hashed):
                continue
            return False
        return True
    return False


def _tombstone_age(row: ChatSpend) -> timedelta:
    """Age of a tombstone, dialect-safe.

    SQLite returns ``created_at`` naive while Postgres returns it aware;
    both store UTC, so normalising to naive UTC makes the subtraction
    valid on either dialect (see issue #412 for the broader class).
    """
    created = row.created_at.replace(tzinfo=None) if row.created_at.tzinfo else row.created_at
    return datetime.now(UTC).replace(tzinfo=None) - created


async def _evict_expired_tombstone(session: AsyncSession, user_id: int, hashed: str) -> bool:
    """Delete a crash-stranded in-flight tombstone; True when one was evicted.

    Only rows with ``result_json IS NULL`` (never finalised) AND older
    than :data:`IN_FLIGHT_TTL` qualify — a completed row replays its
    cached body via :func:`check_idempotency`, and a fresh in-flight row
    keeps its 409 dedup contract.
    """
    result = await session.execute(
        select(ChatSpend).where(
            ChatSpend.user_id == user_id,
            col(ChatSpend.idem_key) == hashed,
        )
    )
    row = result.scalars().first()
    if row is None or row.result_json is not None:
        return False
    age = _tombstone_age(row)
    if age < IN_FLIGHT_TTL:
        return False
    await session.delete(row)
    await session.flush()
    # Support correlation: "user reports stuck retry" ↔ "row N evicted at T".
    logger.info(
        "chat_spend_tombstone_evicted",
        extra={
            "user_id": user_id,
            "chat_spend_id": row.id,
            "age_seconds": int(age.total_seconds()),
        },
    )
    return True


async def update_idem_result(
    session: AsyncSession,
    user_id: int,
    raw_key: str,
    result_json: str,
) -> None:
    """Fill in ``result_json`` on the tombstone so the next replay returns the cached body."""
    hashed = hash_idem_key(user_id, raw_key)
    result = await session.execute(
        select(ChatSpend).where(
            ChatSpend.user_id == user_id,
            col(ChatSpend.idem_key) == hashed,
        )
    )
    row = result.scalars().first()
    if row is not None:
        row.result_json = result_json
        session.add(row)
