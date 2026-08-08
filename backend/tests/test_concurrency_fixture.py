"""Guarantees of the concurrency fixture's in-process SQLite writer queue.

SQLite has no writer queue of its own. When several connections open write
transactions at once, the losers sleep inside SQLite's busy handler and each
retry briefly takes a SHARED read lock, which denies the one connection holding
RESERVED the EXCLUSIVE promotion it needs to COMMIT. The pile-up is bounded
only by the busy timeout, so a loaded runner turns a race into a wall-clock
stall and then a "database is locked" failure.

The fixture therefore serialises writers itself: at most one connection may
hold a write transaction, and a waiting writer sleeps on a fair FIFO lock
instead of gambling in SQLite's retry lottery -- which is what production
PostgreSQL does natively with row-lock wait queues.

The invariant asserted here is about *when* the single write slot is held. It
is taken at a connection's first write statement of a transaction and released
only when that transaction ends -- by commit, by rollback, or by the session
closing. Reads are never serialised behind it.
"""

from __future__ import annotations

import asyncio
from typing import Protocol

import pytest
from sqlalchemy import func, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import select

from models.user import User

# Distinct emails per writer: ``User.email`` is unique, so reusing one across
# tests would make an unrelated IntegrityError look like the savepoint case.
COMMITTING_WRITER_EMAIL = "queue-committing-writer@example.com"
SAVEPOINT_WRITER_EMAIL = "queue-savepoint-writer@example.com"
UNCOMMITTED_WRITER_EMAIL = "queue-uncommitted-writer@example.com"
PLACEHOLDER_PASSWORD_HASH = "x"  # pragma: allowlist secret

# A conditional UPDATE whose predicate matches nothing still opens a write
# transaction, which is the leak shape the queue has to survive: the handler
# returns without committing and the transaction ends only at session close.
UPDATE_MATCHING_NO_ROWS = (
    'UPDATE "user" SET offering_balance = offering_balance + 1 WHERE id = :user_id'
)
MISSING_USER_ID = -1
NO_ROWS_MATCHED = 0

# The rollback journal, not WAL. See the WAL test below for why.
EXPECTED_JOURNAL_MODE = "delete"

# Ordering labels for the reader/writer interleaving assertion.
READ_COMPLETED = "read-completed"
WRITE_COMMITTED = "write-committed"

# Generous enough that a slow runner never trips it, small enough that a
# regression which serialises reads behind writers fails the run in seconds
# instead of parking the suite on the 30 s SQLite busy timeout.
ORDERING_TIMEOUT_SECONDS = 10.0

# No user rows exist before the concurrent writer's uncommitted INSERT, so a
# reader that correctly sees the pre-write snapshot counts zero.
USERS_VISIBLE_BEFORE_COMMIT = 0


class WriterQueue(Protocol):
    """The slice of the fixture's writer-queue API these tests depend on."""

    @property
    def locked(self) -> bool:
        """Whether some connection currently holds the single write slot."""

    @property
    def waiters(self) -> int:
        """How many writers are queued behind the current holder."""


def new_user(email: str) -> User:
    """Build a minimal user row for a write whose only job is to exist."""
    return User(email=email, password_hash=PLACEHOLDER_PASSWORD_HASH)


async def insert_duplicate_inside_a_savepoint(session: AsyncSession, email: str) -> None:
    """Re-insert ``email`` inside a SAVEPOINT so the unique index rejects it.

    Raises IntegrityError once the savepoint has been rolled back, leaving the
    outer transaction open -- the shape the production handlers rely on.
    """
    async with session.begin_nested():
        session.add(new_user(email))
        await session.flush()


@pytest.mark.asyncio
async def test_writer_queue_is_held_by_an_uncommitted_write_and_freed_by_commit(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    concurrent_writer_queue: WriterQueue,
) -> None:
    """A flushed-but-uncommitted INSERT holds the write slot until it commits.

    Taking the slot at the first write statement, rather than at transaction
    start, is what keeps reads parallel; releasing it at commit is what lets
    the next writer through without touching SQLite's busy handler.
    """
    async with concurrent_session_factory() as session:
        session.add(new_user(COMMITTING_WRITER_EMAIL))
        await session.flush()

        assert concurrent_writer_queue.locked is True
        assert concurrent_writer_queue.waiters == 0

        await session.commit()

        assert concurrent_writer_queue.locked is False


@pytest.mark.asyncio
async def test_writer_queue_is_freed_when_a_session_closes_without_committing(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    concurrent_writer_queue: WriterQueue,
) -> None:
    """A write transaction that is never committed frees the slot at session close.

    This is the real leak shape. A handler whose conditional UPDATE matches
    zero rows has still opened a write transaction, and it returns without
    committing, so the only thing that ends that transaction is the session
    closing. A queue released solely on commit would strand every later writer.
    """
    async with concurrent_session_factory() as session:
        connection = await session.connection()
        result = await connection.execute(
            text(UPDATE_MATCHING_NO_ROWS), {"user_id": MISSING_USER_ID}
        )

        assert result.rowcount == NO_ROWS_MATCHED
        assert concurrent_writer_queue.locked is True

    assert concurrent_writer_queue.locked is False


@pytest.mark.asyncio
async def test_rolling_back_a_savepoint_does_not_free_the_writer_queue(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    concurrent_writer_queue: WriterQueue,
) -> None:
    """A rolled-back SAVEPOINT keeps the slot: the outer transaction is still open.

    Several handlers make a SAVEPOINT their first write and roll it back on
    IntegrityError while the outer transaction carries on. Releasing the slot
    on that inner rollback would hand the write lock to a second connection
    while this one still holds SQLite's RESERVED lock -- reintroducing exactly
    the contention the queue exists to remove.
    """
    async with concurrent_session_factory() as session:
        session.add(new_user(SAVEPOINT_WRITER_EMAIL))
        await session.flush()

        assert concurrent_writer_queue.locked is True

        with pytest.raises(IntegrityError):
            await insert_duplicate_inside_a_savepoint(session, SAVEPOINT_WRITER_EMAIL)

        assert concurrent_writer_queue.locked is True

        await session.commit()

        assert concurrent_writer_queue.locked is False


@pytest.mark.asyncio
async def test_reads_are_not_serialized_behind_an_uncommitted_writer(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A SELECT on a second connection completes while a write is still open.

    This guards the sibling concurrency tests' coverage rather than the queue
    itself. Those tests only catch a time-of-check/time-of-use regression
    because the window between one request's read and another's write is wide;
    serialising reads behind writers would slam that window shut and turn a
    real double-credit into a green run.

    The ordering is coordinated with events, not sleeps: the writer refuses to
    commit until the reader reports done, so if reads ever queue behind the
    uncommitted writer the two deadlock and the timeout fails the test loudly.
    """
    write_is_open = asyncio.Event()
    read_is_done = asyncio.Event()
    order: list[str] = []
    users_seen_by_reader = -1

    async def write_and_wait_for_the_reader() -> None:
        async with concurrent_session_factory() as session:
            session.add(new_user(UNCOMMITTED_WRITER_EMAIL))
            await session.flush()
            write_is_open.set()
            await read_is_done.wait()
            await session.commit()
            order.append(WRITE_COMMITTED)

    async def read_while_the_write_is_open() -> None:
        nonlocal users_seen_by_reader
        await write_is_open.wait()
        async with concurrent_session_factory() as session:
            users_seen_by_reader = int(
                (await session.execute(select(func.count()).select_from(User))).scalar_one()
            )
        order.append(READ_COMPLETED)
        read_is_done.set()

    await asyncio.wait_for(
        asyncio.gather(write_and_wait_for_the_reader(), read_while_the_write_is_open()),
        timeout=ORDERING_TIMEOUT_SECONDS,
    )

    assert order == [READ_COMPLETED, WRITE_COMMITTED]
    assert users_seen_by_reader == USERS_VISIBLE_BEFORE_COMMIT


@pytest.mark.asyncio
async def test_concurrency_fixture_does_not_use_wal(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The fixture database stays on the rollback journal, deliberately.

    WAL is the obvious way to stop writers from blocking readers, and it was
    measured and rejected. It shrinks the write window so far that the sibling
    concurrency tests stop catching a time-of-check/time-of-use regression:
    seeded against a known-broken handler they failed 25 of 25 runs on the
    rollback journal and only 7 of 25 under WAL. The in-process writer queue
    buys the same freedom from lock contention without narrowing the window.

    This test exists so a future well-meant switch to WAL announces itself here
    instead of silently blinding the tests that guard the money path.
    """
    async with concurrent_session_factory() as session:
        journal_mode = (await session.execute(text("PRAGMA journal_mode"))).scalar_one()

    assert journal_mode == EXPECTED_JOURNAL_MODE
