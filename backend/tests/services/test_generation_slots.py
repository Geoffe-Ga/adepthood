"""The per-user generation guardrails: the DB lease and the minute bucket (#623).

Decision record §1 ratifies "maximum **5 LLM generations/minute/user**" and
"maximum **2 concurrent generations/user**". The concurrency cap is a lease in
the database so it holds across workers; the minute bucket rides the
application limiter and is per worker (documented in DEPLOYMENT.md).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from http import HTTPStatus

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import col, func, select

from models.generation_slot import GenerationSlot
from models.user import User
from models.wallet_audit import BUCKET_MONTHLY, REASON_SPEND_MONTHLY, WalletAudit
from rate_limit import limiter, user_throttle_key
from services import generation_guardrails
from services.botmason import WORST_CASE_DIAL_SECONDS
from services.generation_guardrails import (
    GENERATION_DIALS_PER_PASS,
    GENERATION_GUARD_UNAVAILABLE,
    GENERATION_IN_PROGRESS,
    GENERATION_IN_PROGRESS_RETRY_AFTER_SECONDS,
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
# _LLM_TIMEOUT_SECONDS (30) x (_MAX_RETRIES (2) + 1) attempts + 1s + 2s backoff.
_EXPECTED_WORST_CASE_DIAL_SECONDS = 93.0
_EXPECTED_TTL_SECONDS = 279.0
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
    """Every number is named, and the TTL is derived from the provider's own bounds."""
    assert GENERATIONS_PER_MINUTE_PER_USER == _RATIFIED_PER_MINUTE
    assert MAX_CONCURRENT_GENERATIONS_PER_USER == _RATIFIED_CONCURRENT
    assert WORST_CASE_DIAL_SECONDS == _EXPECTED_WORST_CASE_DIAL_SECONDS
    assert GENERATION_DIALS_PER_PASS == 3  # pass, corrective pass, detection
    assert GENERATION_SLOT_TTL_SECONDS == _EXPECTED_TTL_SECONDS
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
