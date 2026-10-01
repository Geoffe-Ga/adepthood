"""The configurable daily ceiling on charged generations (#623).

The owner's 2026-09-05 decision (decision record §1) sets a "configurable launch
ceiling of **100 charged generations/day/user**". Record §4 places it as a
"database-backed daily ceiling, env-configurable". It lives in
``services.wallet.preflight_deduction``, the one chokepoint every charged
generation (resonance, essay, transcription) spends through, and counts the
user's net generation spends since 00:00 UTC from ``walletaudit``.

Every refusal here must charge nothing: the spend is staged inside a savepoint
and discarded with it, so the caller's own transaction policy is irrelevant.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal
from http import HTTPStatus

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col, func, select

from domain.dates import seconds_until_next_utc_midnight, utc_day_start
from models.user import User
from models.wallet_audit import (
    BUCKET_MONTHLY,
    GENERATION_REFUND_REASONS,
    GENERATION_SPEND_REASONS,
    REASON_ADMIN_GRANT,
    REASON_GUMROAD_PURCHASE,
    REASON_GUMROAD_REFUND,
    REASON_MONTHLY_RESET,
    REASON_REFUND_FAILED_ESSAY,
    REASON_REFUND_FAILED_RESONANCE,
    REASON_REFUND_NO_ESSAY,
    REASON_REFUND_NO_NOTES,
    REASON_SELF_GRANT,
    REASON_SPEND_MONTHLY,
    REASON_SPEND_OFFERING,
    WalletAudit,
)
from services.usage import (
    DAILY_GENERATION_CEILING_ENV,
    DEFAULT_DAILY_GENERATION_CEILING,
    get_daily_generation_ceiling,
)
from services.wallet import DAILY_GENERATION_LIMIT_REACHED, preflight_deduction

# A small ceiling keeps the seeding cheap; the default is pinned separately.
_CEILING = 3
# A fixed day far enough in the past that the real clock (which stamps the
# row the deduction itself stages) is always after it.
_DAY = datetime(2026, 1, 1, tzinfo=UTC)
_NOON = _DAY + timedelta(hours=12)
_LAST_SECOND = _DAY + timedelta(hours=23, minutes=59, seconds=59)
_NEXT_MIDNIGHT = _DAY + timedelta(days=1)
_SECONDS_PER_DAY = 86_400
_HALF_DAY_SECONDS = 43_200
# Decision record §1: "configurable launch ceiling of 100 charged generations/day/user".
_RATIFIED_DAILY_CEILING = 100
# A comfortably stocked wallet, so only the ceiling can refuse.
_OFFERINGS = 500


async def _make_user(session: AsyncSession, email: str = "daily@example.com") -> int:
    """Create a user with a stocked wallet and no reset due; return its id."""
    now_naive = datetime.now(UTC).replace(tzinfo=None)
    user = User(
        email=email,
        password_hash="x",
        monthly_messages_used=0,
        offering_balance=_OFFERINGS,
        monthly_reset_date=now_naive + timedelta(days=30),
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    assert user.id is not None
    user_id = user.id
    session.expunge(user)
    return user_id


async def _seed(session: AsyncSession, user_id: int, reason: str, count: int, at: datetime) -> None:
    """Write ``count`` committed audit rows of ``reason`` stamped ``at``."""
    for _ in range(count):
        session.add(
            WalletAudit(
                user_id=user_id,
                actor_user_id=user_id,
                bucket=BUCKET_MONTHLY,
                reason=reason,
                delta=Decimal(1),
                balance_before=Decimal(0),
                balance_after=Decimal(1),
                created_at=at,
            )
        )
    await session.commit()


async def _wallet(session: AsyncSession, user_id: int) -> tuple[int, int]:
    session.expire_all()
    user = await session.get(User, user_id)
    assert user is not None
    return user.monthly_messages_used, user.offering_balance


async def _spend_rows(session: AsyncSession, user_id: int) -> int:
    result = await session.execute(
        select(func.count())
        .select_from(WalletAudit)
        .where(
            col(WalletAudit.user_id) == user_id,
            col(WalletAudit.reason).in_(GENERATION_SPEND_REASONS),
        )
    )
    return int(result.scalar_one())


@pytest.fixture
def ceiling(monkeypatch: pytest.MonkeyPatch) -> int:
    """Set the env ceiling to :data:`_CEILING`."""
    monkeypatch.setenv(DAILY_GENERATION_CEILING_ENV, str(_CEILING))
    return _CEILING


# --- configuration ----------------------------------------------------------


def test_default_ceiling_is_the_ratified_one_hundred(monkeypatch: pytest.MonkeyPatch) -> None:
    """Decision record §1: "configurable launch ceiling of 100 charged generations/day/user"."""
    monkeypatch.delenv(DAILY_GENERATION_CEILING_ENV, raising=False)
    assert DEFAULT_DAILY_GENERATION_CEILING == _RATIFIED_DAILY_CEILING
    assert get_daily_generation_ceiling() == DEFAULT_DAILY_GENERATION_CEILING
    assert DAILY_GENERATION_CEILING_ENV == "BOTMASON_DAILY_GENERATION_CEILING"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("", DEFAULT_DAILY_GENERATION_CEILING),
        ("   ", DEFAULT_DAILY_GENERATION_CEILING),
        ("abc", DEFAULT_DAILY_GENERATION_CEILING),
        ("-1", DEFAULT_DAILY_GENERATION_CEILING),
        ("7", 7),
        (" 12 ", 12),
        ("0", 0),
    ],
)
def test_ceiling_env_is_parsed_like_the_monthly_cap(
    monkeypatch: pytest.MonkeyPatch, raw: str, expected: int
) -> None:
    """Unset/blank/malformed/negative fall back to 100; 0 is a real setting (the brake)."""
    monkeypatch.setenv(DAILY_GENERATION_CEILING_ENV, raw)
    assert get_daily_generation_ceiling() == expected


# --- the window helpers -------------------------------------------------------


@pytest.mark.parametrize(
    ("now", "expected"),
    [
        (_DAY, _SECONDS_PER_DAY),
        (_NOON, _HALF_DAY_SECONDS),
        (_LAST_SECOND, 1),
        (_LAST_SECOND + timedelta(milliseconds=500), 1),
        (_LAST_SECOND + timedelta(microseconds=999_999), 1),
        (_DAY + timedelta(microseconds=1), _SECONDS_PER_DAY),
    ],
)
def test_seconds_until_next_utc_midnight(now: datetime, expected: int) -> None:
    """Rounded up, never zero, so a client that waits exactly this long is past midnight."""
    assert seconds_until_next_utc_midnight(now) == expected


def test_window_helpers_read_any_offset_as_utc() -> None:
    """A non-UTC offset is converted, and a naive value is taken to be UTC."""
    # 20:00 on 31 Dec at UTC-5 is 01:00 on 1 Jan UTC.
    late_new_years_eve = datetime(2025, 12, 31, 20, 0, tzinfo=timezone(timedelta(hours=-5)))
    assert utc_day_start(late_new_years_eve) == _DAY
    assert utc_day_start(_NOON.replace(tzinfo=None)) == _DAY
    assert seconds_until_next_utc_midnight(_NOON.replace(tzinfo=None)) == _HALF_DAY_SECONDS


# --- the ceiling ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_admits_the_generation_that_reaches_the_ceiling(
    db_session: AsyncSession, ceiling: int
) -> None:
    """With N-1 charged today, the Nth is admitted and staged."""
    user_id = await _make_user(db_session)
    await _seed(db_session, user_id, REASON_SPEND_MONTHLY, ceiling - 1, _NOON)

    spent = await preflight_deduction(db_session, user_id, now=_NOON)
    await db_session.commit()

    assert spent.monthly_used == 1
    assert await _spend_rows(db_session, user_id) == ceiling


@pytest.mark.asyncio
async def test_preflight_refuses_charge_past_daily_ceiling_net_of_refunds(
    db_session: AsyncSession, ceiling: int
) -> None:
    """The (N+1)th is 429 with an honest Retry-After, and nothing is charged."""
    user_id = await _make_user(db_session)
    await _seed(db_session, user_id, REASON_SPEND_OFFERING, ceiling, _NOON)
    before = await _wallet(db_session, user_id)

    with pytest.raises(HTTPException) as exc:
        await preflight_deduction(db_session, user_id, now=_NOON)

    assert exc.value.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert exc.value.detail == DAILY_GENERATION_LIMIT_REACHED == "daily_generation_limit_reached"
    assert exc.value.headers == {"Retry-After": str(_HALF_DAY_SECONDS)}
    # No explicit rollback: the savepoint alone must have discarded the spend.
    assert not db_session.new
    assert await _spend_rows(db_session, user_id) == ceiling
    assert await _wallet(db_session, user_id) == before


@pytest.mark.asyncio
async def test_zero_ceiling_is_an_emergency_brake(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``0`` refuses every charged generation, even the first of the day."""
    monkeypatch.setenv(DAILY_GENERATION_CEILING_ENV, "0")
    user_id = await _make_user(db_session)
    before = await _wallet(db_session, user_id)

    with pytest.raises(HTTPException) as exc:
        await preflight_deduction(db_session, user_id)

    assert exc.value.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert await _spend_rows(db_session, user_id) == 0
    assert await _wallet(db_session, user_id) == before


@pytest.mark.asyncio
async def test_empty_wallet_is_still_402_not_429(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The hard wallet stop is unchanged and outranks the ceiling."""
    monkeypatch.setenv(DAILY_GENERATION_CEILING_ENV, "0")
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "0")
    user_id = await _make_user(db_session)
    user = await db_session.get(User, user_id)
    assert user is not None
    user.offering_balance = 0
    await db_session.commit()

    with pytest.raises(HTTPException) as exc:
        await preflight_deduction(db_session, user_id)

    assert exc.value.status_code == HTTPStatus.PAYMENT_REQUIRED
    assert exc.value.detail == "insufficient_offerings"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "refund_reason",
    [
        REASON_REFUND_NO_NOTES,
        REASON_REFUND_FAILED_RESONANCE,
        REASON_REFUND_FAILED_ESSAY,
        REASON_REFUND_NO_ESSAY,
    ],
)
async def test_refunded_generations_do_not_count(
    db_session: AsyncSession, ceiling: int, refund_reason: str
) -> None:
    """A spend handed back by a generation refund is not a charged generation."""
    user_id = await _make_user(db_session)
    await _seed(db_session, user_id, REASON_SPEND_MONTHLY, ceiling, _NOON)
    await _seed(db_session, user_id, refund_reason, 1, _NOON)

    await preflight_deduction(db_session, user_id, now=_NOON)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "other_reason",
    [
        REASON_GUMROAD_REFUND,
        REASON_GUMROAD_PURCHASE,
        REASON_ADMIN_GRANT,
        REASON_SELF_GRANT,
        REASON_MONTHLY_RESET,
    ],
)
async def test_non_generation_wallet_rows_do_not_affect_the_count(
    db_session: AsyncSession, ceiling: int, other_reason: str
) -> None:
    """Pack refunds, purchases, grants and resets neither add nor net a generation."""
    user_id = await _make_user(db_session)
    await _seed(db_session, user_id, REASON_SPEND_MONTHLY, ceiling, _NOON)
    await _seed(db_session, user_id, other_reason, 2, _NOON)

    with pytest.raises(HTTPException) as exc:
        await preflight_deduction(db_session, user_id, now=_NOON)

    assert exc.value.status_code == HTTPStatus.TOO_MANY_REQUESTS


def test_reason_sets_are_exactly_the_generation_spends_and_refunds() -> None:
    """Pinned so a new wallet reason is a deliberate decision, not a silent count change."""
    assert frozenset({REASON_SPEND_MONTHLY, REASON_SPEND_OFFERING}) == GENERATION_SPEND_REASONS
    assert (
        frozenset(
            {
                REASON_REFUND_NO_NOTES,
                REASON_REFUND_FAILED_RESONANCE,
                REASON_REFUND_FAILED_ESSAY,
                REASON_REFUND_NO_ESSAY,
            }
        )
        == GENERATION_REFUND_REASONS
    )


@pytest.mark.asyncio
async def test_spends_before_utc_midnight_do_not_count(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """100 spends at 23:59:59 UTC are yesterday's: 00:00:01 is a fresh day."""
    monkeypatch.delenv(DAILY_GENERATION_CEILING_ENV, raising=False)
    user_id = await _make_user(db_session)
    await _seed(
        db_session, user_id, REASON_SPEND_MONTHLY, DEFAULT_DAILY_GENERATION_CEILING, _LAST_SECOND
    )

    with pytest.raises(HTTPException) as late:
        await preflight_deduction(db_session, user_id, now=_LAST_SECOND)
    assert late.value.headers == {"Retry-After": "1"}

    await preflight_deduction(db_session, user_id, now=_NEXT_MIDNIGHT + timedelta(seconds=1))


@pytest.mark.asyncio
async def test_a_spend_at_exactly_midnight_counts_for_the_new_day(
    db_session: AsyncSession, ceiling: int
) -> None:
    """The window is inclusive of 00:00:00.000000 UTC."""
    user_id = await _make_user(db_session)
    await _seed(db_session, user_id, REASON_SPEND_MONTHLY, ceiling, _NEXT_MIDNIGHT)

    with pytest.raises(HTTPException) as exc:
        await preflight_deduction(db_session, user_id, now=_NEXT_MIDNIGHT + timedelta(seconds=1))

    assert exc.value.status_code == HTTPStatus.TOO_MANY_REQUESTS


@pytest.mark.asyncio
async def test_another_users_spends_never_count(db_session: AsyncSession, ceiling: int) -> None:
    """The count is keyed on the authenticated user, never shared."""
    alice = await _make_user(db_session, "alice_daily@example.com")
    bob = await _make_user(db_session, "bob_daily@example.com")
    await _seed(db_session, alice, REASON_SPEND_MONTHLY, ceiling, _NOON)

    await preflight_deduction(db_session, bob, now=_NOON)


@pytest.mark.asyncio
async def test_concurrent_requests_at_n_minus_one_admit_exactly_one(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    ceiling: int,
) -> None:
    """The count follows the row-locking spend UPDATE, so racing requests serialize."""
    async with concurrent_session_factory() as setup:
        user_id = await _make_user(setup)
        await _seed(setup, user_id, REASON_SPEND_MONTHLY, ceiling - 1, datetime.now(UTC))

    async def _attempt() -> int:
        async with concurrent_session_factory() as session:
            try:
                await preflight_deduction(session, user_id)
            except HTTPException as exc:
                await session.rollback()
                return exc.status_code
            await session.commit()
            return HTTPStatus.OK

    outcomes = await asyncio.gather(_attempt(), _attempt())

    assert sorted(outcomes) == [HTTPStatus.OK, HTTPStatus.TOO_MANY_REQUESTS]
    async with concurrent_session_factory() as check:
        assert await _spend_rows(check, user_id) == ceiling
