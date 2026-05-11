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

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.chat_spend import ChatSpend


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
    try:
        async with session.begin_nested():
            session.add(ChatSpend(user_id=user_id, idem_key=hashed))
            await session.flush()
    except IntegrityError:
        return False
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
