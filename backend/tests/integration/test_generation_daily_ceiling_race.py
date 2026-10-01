"""PostgreSQL proof that the daily generation ceiling counts after the row lock (#623).

``preflight_deduction`` stages the spend's row-locking ``UPDATE`` first and
only then counts today's net generation spends, so a request racing another
for the same user waits on that lock and counts the spend it waited on. The
SQLite lane cannot show this: its one database-wide write lock serializes two
preflights from their first write, so a count taken *before* the row lock
passes there too. On PostgreSQL's row locks under READ COMMITTED that count
reads a stale total, and two requests at ``ceiling - 1`` would both be
admitted -- so the ordering is proved here.

The interleaving is forced, not hoped for: the first preflight holds its
staged spend uncommitted, the second is observed waiting on a lock in
``pg_stat_activity``, and only then does the first commit.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from http import HTTPStatus
from typing import TYPE_CHECKING

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlmodel import col, func, select

from models.user import User
from models.wallet_audit import (
    BUCKET_MONTHLY,
    GENERATION_SPEND_REASONS,
    REASON_SPEND_MONTHLY,
    WalletAudit,
)
from services.usage import DAILY_GENERATION_CEILING_ENV
from services.wallet import DAILY_GENERATION_LIMIT_REACHED, preflight_deduction

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from tests.integration.session_per_request import SessionPerRequest

pytestmark = pytest.mark.integration

# A small ceiling keeps the seeding cheap; the shape is the same at 100.
_CEILING = 3
# A comfortably stocked wallet, so only the ceiling can refuse.
_OFFERINGS = 50
# How long the second preflight may take to reach the lock; only a broken
# interleaving reaches it.
_BLOCK_WAIT_SECONDS = 10.0
_POLL_SECONDS = 0.01
_LOCK_WAITERS = text(
    "SELECT count(*) FROM pg_stat_activity "
    "WHERE datname = current_database() AND wait_event_type = 'Lock'"
)


async def _make_user(session: AsyncSession) -> int:
    """A user with a stocked wallet, no reset due, and ``_CEILING - 1`` spends today."""
    user = User(
        email="daily_race@example.com",
        password_hash="x",
        monthly_messages_used=0,
        offering_balance=_OFFERINGS,
        monthly_reset_date=datetime.now(UTC).replace(tzinfo=None) + timedelta(days=30),
    )
    session.add(user)
    await session.flush()
    assert user.id is not None
    user_id = user.id
    for _ in range(_CEILING - 1):
        session.add(
            WalletAudit(
                user_id=user_id,
                actor_user_id=user_id,
                bucket=BUCKET_MONTHLY,
                reason=REASON_SPEND_MONTHLY,
                delta=Decimal(1),
                balance_before=Decimal(0),
                balance_after=Decimal(1),
            )
        )
    await session.commit()
    return user_id


async def _until_a_lock_waiter(factory: async_sessionmaker[AsyncSession]) -> None:
    """Return once some backend in this database is waiting on a lock."""

    async def _poll() -> None:
        while True:
            async with factory() as probe:
                if (await probe.execute(_LOCK_WAITERS)).scalar_one():
                    return
            await asyncio.sleep(_POLL_SECONDS)

    await asyncio.wait_for(_poll(), _BLOCK_WAIT_SECONDS)


async def _attempt(factory: async_sessionmaker[AsyncSession], user_id: int) -> object:
    """One preflight in its own session: ``200`` committed, or the refusal's detail."""
    async with factory() as session:
        try:
            await preflight_deduction(session, user_id)
        except HTTPException as exc:
            await session.rollback()
            return exc.detail
        await session.commit()
        return HTTPStatus.OK


@pytest.mark.asyncio
async def test_a_preflight_behind_a_staged_spend_counts_it_on_postgres(
    pair: SessionPerRequest, monkeypatch: pytest.MonkeyPatch
) -> None:
    """At ``ceiling - 1``, the request that waited on the lock is refused, not admitted."""
    monkeypatch.setenv(DAILY_GENERATION_CEILING_ENV, str(_CEILING))
    async with pair.factory() as setup:
        user_id = await _make_user(setup)

    async with pair.factory() as first:
        await preflight_deduction(first, user_id)
        second = asyncio.create_task(_attempt(pair.factory, user_id))
        await _until_a_lock_waiter(pair.factory)
        assert not second.done()
        await first.commit()

    assert await second == DAILY_GENERATION_LIMIT_REACHED
    async with pair.factory() as check:
        spends = await check.execute(
            select(func.count())
            .select_from(WalletAudit)
            .where(
                col(WalletAudit.user_id) == user_id,
                col(WalletAudit.reason).in_(GENERATION_SPEND_REASONS),
            )
        )
        assert spends.scalar_one() == _CEILING
