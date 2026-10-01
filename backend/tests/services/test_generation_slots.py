"""The per-user generation guardrails: the DB lease and the minute bucket (#623).

Decision record §1 ratifies "maximum **5 LLM generations/minute/user**" and
"maximum **2 concurrent generations/user**". The concurrency cap is a lease in
the database so it holds across workers; the minute bucket rides the
application limiter and is per worker (documented in DEPLOYMENT.md).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from http import HTTPStatus

import pytest
from fastapi import HTTPException
from sqlalchemy import delete
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import col, func, select

from domain.dates import ensure_aware
from models.generation_slot import GenerationSlot
from models.user import User
from models.wallet_audit import BUCKET_MONTHLY, REASON_SPEND_MONTHLY, WalletAudit
from rate_limit import limiter, user_throttle_key
from services import generation_guardrails
from services.generation_guardrails import (
    GENERATION_GUARD_UNAVAILABLE,
    GENERATION_IN_PROGRESS,
    GENERATION_IN_PROGRESS_RETRY_AFTER_SECONDS,
    GENERATION_SLOT_HEARTBEAT_SECONDS,
    GENERATION_SLOT_HEARTBEAT_TASK,
    GENERATION_SLOT_HEARTBEATS_PER_TTL,
    GENERATION_SLOT_TTL_SECONDS,
    GENERATIONS_PER_MINUTE_PER_USER,
    MAX_CONCURRENT_GENERATIONS_PER_USER,
    consume_generation_minute,
    generation_slot,
    open_lease_session,
    require_generation_minute_available,
)

# Decision record §1.
_RATIFIED_PER_MINUTE = 5
_RATIFIED_CONCURRENT = 2
# A live lease is refreshed every 30s and lives 90s from its last refresh, so it
# survives two consecutive failed refreshes and a crashed worker's frees in 90s.
_EXPECTED_HEARTBEAT_SECONDS = 30.0
_EXPECTED_HEARTBEATS_PER_TTL = 3
_EXPECTED_TTL_SECONDS = 90.0
# The static TTL this module shipped with before the heartbeat (3 x a 93s dial):
# the reviewers showed a live generation outlasting it behind the account barrier.
_PRE_HEARTBEAT_TTL_SECONDS = 279.0
# A heartbeat interval short enough for a test to watch several ticks.
_FAST_HEARTBEAT_SECONDS = 0.01
# How long a test waits for a heartbeat it expects; only a broken one reaches it.
_HEARTBEAT_WAIT_SECONDS = 10.0
# A fixed instant the lease clock is frozen at.
_T0 = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
_PROVIDER_TIMEOUT_SECONDS = 30
# The release-failure test fails one release on an exception exit and one on a
# normal exit.
_FAILED_RELEASES = 2
# The minute bucket's window, the ceiling on any honest Retry-After it gives.
_MINUTE_SECONDS = 60


async def _make_user(session: AsyncSession, email: str) -> int:
    user = User(email=email, password_hash="x")
    session.add(user)
    await session.commit()
    await session.refresh(user)
    assert user.id is not None
    return user.id


async def _lease_count(session: AsyncSession, user_id: int | None = None) -> int:
    query = select(func.count()).select_from(GenerationSlot)
    if user_id is not None:
        query = query.where(col(GenerationSlot.user_id) == user_id)
    return int((await session.execute(query)).scalar_one())


# --- the constants ------------------------------------------------------------


def test_constants_are_the_ratified_numbers_and_derived_ttl() -> None:
    """Every number is named, and the TTL is a whole number of heartbeats."""
    assert GENERATIONS_PER_MINUTE_PER_USER == _RATIFIED_PER_MINUTE
    assert MAX_CONCURRENT_GENERATIONS_PER_USER == _RATIFIED_CONCURRENT
    assert GENERATION_SLOT_HEARTBEAT_SECONDS == _EXPECTED_HEARTBEAT_SECONDS
    assert GENERATION_SLOT_HEARTBEATS_PER_TTL == _EXPECTED_HEARTBEATS_PER_TTL
    assert GENERATION_SLOT_TTL_SECONDS == _EXPECTED_TTL_SECONDS
    assert (
        GENERATION_SLOT_TTL_SECONDS
        == GENERATION_SLOT_HEARTBEAT_SECONDS * GENERATION_SLOT_HEARTBEATS_PER_TTL
    )
    assert GENERATION_IN_PROGRESS_RETRY_AFTER_SECONDS == _PROVIDER_TIMEOUT_SECONDS
    assert GENERATION_IN_PROGRESS == "generation_in_progress"
    assert GENERATION_GUARD_UNAVAILABLE == "generation_guard_unavailable"


def test_user_throttle_key_is_the_per_user_limiter_key() -> None:
    """One spelling of the per-user key, shared with ``per_user_rate_limit_key``."""
    assert user_throttle_key(7) == "user:7"


# --- the lease -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_two_slots_admit_and_a_third_is_refused_across_two_workers(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Two engines on one database (two workers) still admit only two."""
    bind = concurrent_session_factory.kw["bind"]
    second_worker = create_async_engine(bind.url, connect_args={"timeout": 30})
    other_factory = async_sessionmaker(second_worker, expire_on_commit=False)
    try:
        async with concurrent_session_factory() as setup:
            user_id = await _make_user(setup, "slots@example.com")
            other_id = await _make_user(setup, "other_slots@example.com")
        async with (
            concurrent_session_factory() as first,
            other_factory() as second,
            concurrent_session_factory() as third,
            other_factory() as fourth,
        ):
            async with generation_slot(first, user_id), generation_slot(second, user_id):
                with pytest.raises(HTTPException) as exc:
                    async with generation_slot(third, user_id):
                        pytest.fail("a third concurrent generation was admitted")
                assert exc.value.status_code == HTTPStatus.TOO_MANY_REQUESTS
                assert exc.value.detail == GENERATION_IN_PROGRESS
                assert exc.value.headers == {
                    "Retry-After": str(GENERATION_IN_PROGRESS_RETRY_AFTER_SECONDS)
                }
                # Another user is never blocked by this user's slots.
                async with generation_slot(fourth, other_id):
                    pass
            # Both released: two more are admitted.
            async with generation_slot(third, user_id), generation_slot(fourth, user_id):
                pass
        async with concurrent_session_factory() as check:
            assert await _lease_count(check) == 0
    finally:
        await second_worker.dispose()


@pytest.mark.asyncio
async def test_a_held_lease_records_the_derived_ttl(db_session: AsyncSession) -> None:
    """``expires_at`` is ``acquired_at`` plus the TTL, so a crash frees the slot."""
    user_id = await _make_user(db_session, "ttl@example.com")
    async with generation_slot(db_session, user_id):
        lease = (await db_session.execute(select(GenerationSlot))).scalar_one()
        assert lease.slot == 0
        assert lease.user_id == user_id
        held_for = lease.expires_at - lease.acquired_at
        assert held_for == timedelta(seconds=GENERATION_SLOT_TTL_SECONDS)


@pytest.mark.asyncio
async def test_expired_leases_are_reclaimed(db_session: AsyncSession) -> None:
    """A crashed worker's leases past their TTL no longer count against the user."""
    user_id = await _make_user(db_session, "expired@example.com")
    long_ago = datetime.now(UTC) - timedelta(hours=1)
    for slot in range(MAX_CONCURRENT_GENERATIONS_PER_USER):
        db_session.add(
            GenerationSlot(
                user_id=user_id,
                slot=slot,
                acquired_at=long_ago,
                expires_at=long_ago + timedelta(seconds=1),
            )
        )
    await db_session.commit()

    async with generation_slot(db_session, user_id):
        assert await _lease_count(db_session, user_id) == 1

    assert await _lease_count(db_session, user_id) == 0


@pytest.mark.asyncio
async def test_unexpired_leases_still_block(db_session: AsyncSession) -> None:
    """Only a lease past its TTL is reclaimed; a live one keeps its slot."""
    user_id = await _make_user(db_session, "live@example.com")
    now = datetime.now(UTC)
    for slot in range(MAX_CONCURRENT_GENERATIONS_PER_USER):
        db_session.add(
            GenerationSlot(
                user_id=user_id,
                slot=slot,
                acquired_at=now,
                expires_at=now + timedelta(minutes=1),
            )
        )
    await db_session.commit()

    with pytest.raises(HTTPException) as exc:
        async with generation_slot(db_session, user_id):
            pytest.fail("admitted past two live leases")

    assert exc.value.detail == GENERATION_IN_PROGRESS
    assert await _lease_count(db_session, user_id) == MAX_CONCURRENT_GENERATIONS_PER_USER


# --- the expiry boundary and the heartbeat -------------------------------------------


class _Clock:
    """A settable stand-in for the guardrails' wall clock."""

    def __init__(self) -> None:
        self.now = _T0

    def __call__(self) -> datetime:
        return self.now


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> _Clock:
    """Freeze ``generation_guardrails``' notion of now at ``_T0``, movable by the test."""
    frozen = _Clock()
    monkeypatch.setattr(generation_guardrails, "_utc_now", frozen)
    return frozen


@pytest.fixture
def fast_heartbeat(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tick the lease heartbeat every few milliseconds instead of every 30 seconds."""
    monkeypatch.setattr(
        generation_guardrails, "GENERATION_SLOT_HEARTBEAT_SECONDS", _FAST_HEARTBEAT_SECONDS
    )


async def _fill_every_slot(session: AsyncSession, user_id: int, expires_at: datetime) -> None:
    """Hold every one of ``user_id``'s slots with leases expiring at ``expires_at``."""
    for slot in range(MAX_CONCURRENT_GENERATIONS_PER_USER):
        session.add(
            GenerationSlot(
                user_id=user_id,
                slot=slot,
                acquired_at=expires_at - timedelta(seconds=GENERATION_SLOT_TTL_SECONDS),
                expires_at=expires_at,
            )
        )
    await session.commit()


async def _refusal(session: AsyncSession, user_id: int) -> object:
    """The detail one more generation for ``user_id`` is refused with now; ``None`` if admitted."""
    try:
        async with generation_slot(session, user_id):
            return None
    except HTTPException as exc:
        return exc.detail


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("expires_in", "admitted"),
    [
        # A few seconds past expiry: a crashed worker's lease, reclaimed.
        (timedelta(seconds=-3), True),
        # The last instant before ``now``: already expired.
        (timedelta(microseconds=-1), True),
        # Exactly ``now``: a lease is live through the instant it expires at.
        (timedelta(0), False),
        # A few seconds from expiry: still live, still holding its slot.
        (timedelta(seconds=3), False),
    ],
)
async def test_the_expiry_boundary_is_exact(
    db_session: AsyncSession, clock: _Clock, expires_in: timedelta, *, admitted: bool
) -> None:
    """Only a lease whose ``expires_at`` is strictly before now is reclaimed."""
    user_id = await _make_user(db_session, "boundary@example.com")
    await _fill_every_slot(db_session, user_id, clock.now + expires_in)

    expected = None if admitted else GENERATION_IN_PROGRESS
    assert await _refusal(db_session, user_id) == expected


async def _leases_of(session: AsyncSession, user_id: int) -> list[GenerationSlot]:
    query = select(GenerationSlot).where(col(GenerationSlot.user_id) == user_id)
    return list((await session.execute(query)).scalars().all())


async def _wait_until(predicate: Callable[[], object]) -> bool:
    """Poll ``predicate`` (sync or async) until it is truthy; ``False`` on timeout."""

    async def _poll() -> None:
        while True:
            outcome = predicate()
            if asyncio.iscoroutine(outcome):
                outcome = await outcome
            if outcome:
                return
            await asyncio.sleep(_FAST_HEARTBEAT_SECONDS)

    try:
        await asyncio.wait_for(_poll(), _HEARTBEAT_WAIT_SECONDS)
    except TimeoutError:
        return False
    return True


@pytest.mark.asyncio
@pytest.mark.usefixtures("fast_heartbeat")
async def test_two_live_generations_past_the_old_ttl_still_block_a_third(
    concurrent_session_factory: async_sessionmaker[AsyncSession], clock: _Clock
) -> None:
    """A live generation's lease never expires, however long the generation runs.

    The regression: the slot is taken before ``hold_account``, which waits with
    no timeout, so a static TTL let a live generation's lease age out and a
    third generation in. Here both holders outlive the old 279s TTL and the new
    90s one, and the heartbeat keeps their slots.
    """
    async with concurrent_session_factory() as setup:
        user_id = await _make_user(setup, "long_haul@example.com")
    finish = asyncio.Event()
    holding: list[int] = []

    async def _generate() -> None:
        async with concurrent_session_factory() as session, generation_slot(session, user_id):
            holding.append(user_id)
            await finish.wait()

    holders = [asyncio.create_task(_generate()) for _ in range(_RATIFIED_CONCURRENT)]
    try:
        assert await _wait_until(lambda: len(holding) == _RATIFIED_CONCURRENT)
        later = _T0 + timedelta(seconds=_PRE_HEARTBEAT_TTL_SECONDS + GENERATION_SLOT_TTL_SECONDS)
        clock.now = later

        async def _refreshed() -> bool:
            async with concurrent_session_factory() as probe:
                leases = await _leases_of(probe, user_id)
            return all(ensure_aware(lease.expires_at) > later for lease in leases)

        # Give the heartbeat its chance; the assertion below is what decides.
        await _wait_until(_refreshed)
        async with concurrent_session_factory() as third:
            refusal = await _refusal(third, user_id)
            assert refusal == GENERATION_IN_PROGRESS, "a third generation was admitted"
            assert await _lease_count(third, user_id) == _RATIFIED_CONCURRENT
    finally:
        finish.set()
        await asyncio.gather(*holders)

    async with concurrent_session_factory() as check:
        assert await _lease_count(check, user_id) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("fast_heartbeat")
async def test_a_heartbeat_extends_the_lease_from_its_own_now(
    db_session: AsyncSession, clock: _Clock
) -> None:
    """Each refresh moves ``expires_at`` to the refresh's now plus one TTL."""
    user_id = await _make_user(db_session, "refresh@example.com")
    later = _T0 + timedelta(hours=1)

    async with generation_slot(db_session, user_id):
        clock.now = later
        expected = later + timedelta(seconds=GENERATION_SLOT_TTL_SECONDS)

        async def _extended() -> bool:
            await db_session.rollback()
            leases = await _leases_of(db_session, user_id)
            return [ensure_aware(lease.expires_at) for lease in leases] == [expected]

        assert await _wait_until(_extended)


@pytest.mark.asyncio
@pytest.mark.usefixtures("fast_heartbeat")
async def test_a_failed_refresh_is_logged_and_the_generation_carries_on(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A refresh error is logged and retried next tick; it never fails the request."""
    user_id = await _make_user(db_session, "blip@example.com")
    real = open_lease_session

    def _failed() -> bool:
        return any(r.getMessage() == "generation_slot_refresh_failed" for r in caplog.records)

    with caplog.at_level(logging.ERROR, logger=generation_guardrails.__name__):
        async with generation_slot(db_session, user_id):
            monkeypatch.setattr(
                generation_guardrails, "open_lease_session", lambda _session: _BrokenSession()
            )
            assert await _wait_until(_failed)
            monkeypatch.setattr(generation_guardrails, "open_lease_session", real)

    assert await _lease_count(db_session, user_id) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("fast_heartbeat")
async def test_a_lease_reclaimed_from_under_a_live_generation_is_reported(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    """A refresh that finds its lease gone warns rather than silently over-admitting."""
    user_id = await _make_user(db_session, "lost@example.com")

    def _lost() -> bool:
        return any(r.getMessage() == "generation_slot_lost" for r in caplog.records)

    with caplog.at_level(logging.WARNING, logger=generation_guardrails.__name__):
        async with generation_slot(db_session, user_id):
            await db_session.execute(
                delete(GenerationSlot).where(col(GenerationSlot.user_id) == user_id)
            )
            await db_session.commit()
            assert await _wait_until(_lost)


@pytest.mark.asyncio
@pytest.mark.usefixtures("fast_heartbeat")
async def test_the_heartbeat_stops_when_the_generation_ends(db_session: AsyncSession) -> None:
    """No heartbeat outlives its generation, on a normal or an exception exit."""
    user_id = await _make_user(db_session, "stopped@example.com")

    def _heartbeats() -> list[asyncio.Task[object]]:
        return [
            task
            for task in asyncio.all_tasks()
            if task.get_name() == GENERATION_SLOT_HEARTBEAT_TASK and not task.done()
        ]

    async with generation_slot(db_session, user_id):
        assert len(_heartbeats()) == 1
    assert _heartbeats() == []

    seen: list[int] = []

    async def _fail_mid_flight() -> None:
        async with generation_slot(db_session, user_id):
            seen.append(len(_heartbeats()))
            raise RuntimeError("mid-flight")

    with pytest.raises(RuntimeError, match="mid-flight"):
        await _fail_mid_flight()
    assert seen == [1]
    assert _heartbeats() == []
    assert await _lease_count(db_session, user_id) == 0


class _BrokenSession:
    """A lease session whose every statement fails like a dropped connection."""

    async def __aenter__(self) -> _BrokenSession:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        return None

    async def execute(self, *_args: object, **_kwargs: object) -> None:
        raise OperationalError("DELETE", {}, Exception("connection refused"))


@pytest.mark.asyncio
async def test_an_acquire_error_refuses_and_never_admits(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fail closed: an unreadable lease table is a 503, and the body never runs."""
    user_id = await _make_user(db_session, "broken@example.com")
    monkeypatch.setattr(
        generation_guardrails, "open_lease_session", lambda _session: _BrokenSession()
    )
    ran = False

    with pytest.raises(HTTPException) as exc:
        async with generation_slot(db_session, user_id):
            ran = True

    assert exc.value.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert exc.value.detail == GENERATION_GUARD_UNAVAILABLE
    assert ran is False


async def _stage_a_spend_then_fail(session: AsyncSession, user_id: int) -> None:
    """Inside a slot, flush an uncommitted spend row, then fail like a route would."""
    async with generation_slot(session, user_id):
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
        await session.flush()
        raise RuntimeError("mid-generation")


@pytest.mark.asyncio
async def test_an_exception_exit_rolls_back_staged_work_and_releases(
    db_session: AsyncSession,
) -> None:
    """The request's uncommitted writes never ride the release commit."""
    user_id = await _make_user(db_session, "boom@example.com")

    with pytest.raises(RuntimeError, match="mid-generation"):
        await _stage_a_spend_then_fail(db_session, user_id)

    assert await _lease_count(db_session, user_id) == 0
    audits = await db_session.execute(select(func.count()).select_from(WalletAudit))
    assert audits.scalar_one() == 0


@pytest.mark.asyncio
async def test_a_normal_exit_releases_without_rolling_the_request_back(
    db_session: AsyncSession,
) -> None:
    """On success the route has committed; nothing it loaded is expired."""
    user_id = await _make_user(db_session, "fine@example.com")
    user = await db_session.get(User, user_id)
    assert user is not None

    async with generation_slot(db_session, user_id):
        assert await _lease_count(db_session, user_id) == 1

    # An expired attribute is dropped from the instance dict until reloaded.
    assert "email" in user.__dict__
    assert await _lease_count(db_session, user_id) == 0


@pytest.mark.asyncio
async def test_a_release_failure_is_logged_and_never_masks_the_outcome(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A lease that cannot be deleted is left to its TTL; the request's own result stands."""
    user_id = await _make_user(db_session, "sticky@example.com")
    real = open_lease_session

    calls = 0

    def _fail_on_release(session: AsyncSession) -> object:
        nonlocal calls
        calls += 1
        return real(session) if calls == 1 else _BrokenSession()

    monkeypatch.setattr(generation_guardrails, "open_lease_session", _fail_on_release)

    with caplog.at_level(logging.ERROR, logger=generation_guardrails.__name__):
        with pytest.raises(ValueError, match="the route's own error"):
            async with generation_slot(db_session, user_id):
                raise ValueError("the route's own error")
        calls = 0
        async with generation_slot(db_session, user_id):
            pass

    released = [r for r in caplog.records if r.getMessage() == "generation_slot_release_failed"]
    assert len(released) == _FAILED_RELEASES


# --- the minute bucket ------------------------------------------------------------


def test_the_sixth_generation_in_a_minute_is_refused_with_retry_after() -> None:
    """Five admitted, the sixth answers the generic per-minute 429."""
    for _ in range(GENERATIONS_PER_MINUTE_PER_USER):
        consume_generation_minute(11)

    with pytest.raises(HTTPException) as exc:
        consume_generation_minute(11)

    assert exc.value.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert exc.value.detail == "rate_limit_exceeded"
    assert exc.value.headers is not None
    assert 1 <= int(exc.value.headers["Retry-After"]) <= _MINUTE_SECONDS


def test_a_peek_never_consumes_and_refuses_once_spent() -> None:
    """The admission peek is free; it refuses only after five real generations."""
    for _ in range(GENERATIONS_PER_MINUTE_PER_USER * 2):
        require_generation_minute_available(12)
    for _ in range(GENERATIONS_PER_MINUTE_PER_USER):
        consume_generation_minute(12)

    with pytest.raises(HTTPException) as exc:
        require_generation_minute_available(12)

    assert exc.value.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert exc.value.detail == "rate_limit_exceeded"


def test_the_bucket_is_per_user() -> None:
    """One user's spent minute never refuses another's."""
    for _ in range(GENERATIONS_PER_MINUTE_PER_USER):
        consume_generation_minute(13)

    require_generation_minute_available(14)
    consume_generation_minute(14)


def test_the_bucket_honours_the_limiter_kill_switch() -> None:
    """``disable_rate_limit`` silences the minute bucket (the DB caps ignore it)."""
    limiter.enabled = False
    for _ in range(GENERATIONS_PER_MINUTE_PER_USER * 2):
        consume_generation_minute(15)
        require_generation_minute_available(15)
    limiter.enabled = True

    for _ in range(GENERATIONS_PER_MINUTE_PER_USER):
        consume_generation_minute(15)
    with pytest.raises(HTTPException):
        consume_generation_minute(15)
