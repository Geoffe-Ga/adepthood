"""Unit tests for :mod:`services.wallet` — pure DB-level wallet mutations.

These tests exercise the service layer directly against the shared
``db_session`` fixture, without spinning up an HTTP client.  That keeps each
scenario tight and proves the wallet primitives can be reused from
background jobs or admin tooling that does not touch FastAPI.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from http import HTTPStatus

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.user import User
from models.wallet_audit import (
    BUCKET_MONTHLY,
    BUCKET_OFFERING,
    REASON_ADMIN_GRANT,
    REASON_SELF_GRANT,
    REASON_SPEND_MONTHLY,
    REASON_SPEND_OFFERING,
    WalletAudit,
)
from services.wallet import (
    SpendResult,
    add_balance,
    get_user_fresh,
    preflight_deduction,
    require_user_fresh,
    reset_monthly_usage_if_due,
    spend_one_message,
)


async def _audit_rows(session: AsyncSession, user_id: int) -> list[WalletAudit]:
    """Return every audit row for ``user_id`` in insertion order."""
    result = await session.execute(
        select(WalletAudit).where(col(WalletAudit.user_id) == user_id).order_by(col(WalletAudit.id))
    )
    return list(result.scalars().all())


_MONTHLY_CAP = 5
# Initial monthly usage used by the no-op rollover scenario.  Any non-zero
# value works; the assertion only checks that the counter survives untouched.
_SEEDED_MONTHLY_USED = 4


async def _make_user(
    session: AsyncSession,
    *,
    email: str = "alice@example.com",
    monthly_used: int = 0,
    offering_balance: int = 0,
    reset_in_days: int = 30,
) -> User:
    """Create and persist a minimal :class:`User` for wallet tests.

    The caller's ``session`` runs against SQLite which returns timezone-naive
    datetimes; we therefore write naive values at creation time so the row and
    any subsequent ``UPDATE … WHERE monthly_reset_date <= :now`` comparison
    stay comparable.  Expunging the in-memory instance afterwards forces the
    service-under-test to re-read the row through ``get_user_fresh``.
    """
    now_naive = datetime.now(UTC).replace(tzinfo=None)
    user = User(
        email=email,
        monthly_messages_used=monthly_used,
        offering_balance=offering_balance,
        monthly_reset_date=now_naive + timedelta(days=reset_in_days),
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    session.expunge(user)
    return user


@pytest.mark.asyncio
async def test_get_user_fresh_returns_user_when_exists(db_session: AsyncSession) -> None:
    user = await _make_user(db_session)
    assert user.id is not None
    fetched = await get_user_fresh(db_session, user.id)
    assert fetched is not None
    assert fetched.email == user.email


@pytest.mark.asyncio
async def test_get_user_fresh_returns_none_when_missing(db_session: AsyncSession) -> None:
    assert await get_user_fresh(db_session, user_id=999) is None


@pytest.mark.asyncio
async def test_require_user_fresh_raises_400_when_missing(db_session: AsyncSession) -> None:
    with pytest.raises(HTTPException) as excinfo:
        await require_user_fresh(db_session, user_id=999)
    assert excinfo.value.status_code == HTTPStatus.BAD_REQUEST
    assert excinfo.value.detail == "user_not_found"


@pytest.mark.asyncio
async def test_reset_monthly_usage_rolls_over_when_due(db_session: AsyncSession) -> None:
    """An expired reset date triggers the zero-and-advance update."""
    user = await _make_user(db_session, monthly_used=3, reset_in_days=-1)
    assert user.id is not None

    now_naive = datetime.now(UTC).replace(tzinfo=None)
    await reset_monthly_usage_if_due(db_session, user.id, now_naive)
    await db_session.commit()

    refreshed = await get_user_fresh(db_session, user.id)
    assert refreshed is not None
    assert refreshed.monthly_messages_used == 0
    # Reset date must advance into the future so subsequent rollovers are no-ops.
    assert refreshed.monthly_reset_date > now_naive


@pytest.mark.asyncio
async def test_reset_monthly_usage_is_noop_when_not_due(db_session: AsyncSession) -> None:
    user = await _make_user(db_session, monthly_used=_SEEDED_MONTHLY_USED, reset_in_days=30)
    assert user.id is not None
    before = user.monthly_reset_date

    await reset_monthly_usage_if_due(db_session, user.id, datetime.now(UTC).replace(tzinfo=None))
    await db_session.commit()

    refreshed = await get_user_fresh(db_session, user.id)
    assert refreshed is not None
    assert refreshed.monthly_messages_used == _SEEDED_MONTHLY_USED  # untouched
    assert refreshed.monthly_reset_date == before


@pytest.mark.asyncio
async def test_spend_one_message_drains_monthly_first(db_session: AsyncSession) -> None:
    user = await _make_user(db_session, monthly_used=0, offering_balance=10)
    assert user.id is not None

    result = await spend_one_message(db_session, user.id, _MONTHLY_CAP)
    await db_session.commit()

    assert result == SpendResult(monthly_used=1, offering_balance=10)


@pytest.mark.asyncio
async def test_spend_one_message_falls_through_to_offerings(db_session: AsyncSession) -> None:
    """When the monthly bucket is full, the next spend hits ``offering_balance``."""
    user = await _make_user(db_session, monthly_used=_MONTHLY_CAP, offering_balance=3)
    assert user.id is not None

    result = await spend_one_message(db_session, user.id, _MONTHLY_CAP)
    await db_session.commit()

    assert result == SpendResult(monthly_used=_MONTHLY_CAP, offering_balance=2)


@pytest.mark.asyncio
async def test_spend_one_message_returns_none_when_both_empty(db_session: AsyncSession) -> None:
    user = await _make_user(db_session, monthly_used=_MONTHLY_CAP, offering_balance=0)
    assert user.id is not None

    assert await spend_one_message(db_session, user.id, _MONTHLY_CAP) is None


@pytest.mark.asyncio
async def test_preflight_deduction_returns_spend_result(db_session: AsyncSession) -> None:
    user = await _make_user(db_session, monthly_used=0)
    assert user.id is not None

    result = await preflight_deduction(db_session, user.id)
    await db_session.commit()

    assert isinstance(result, SpendResult)
    assert result.monthly_used == 1


@pytest.mark.asyncio
async def test_preflight_deduction_raises_402_when_empty(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With both wallets empty and ``BOTMASON_MONTHLY_CAP=0``, preflight must 402."""
    user = await _make_user(db_session, monthly_used=0, offering_balance=0)
    assert user.id is not None

    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "0")
    with pytest.raises(HTTPException) as excinfo:
        await preflight_deduction(db_session, user.id)

    assert excinfo.value.status_code == HTTPStatus.PAYMENT_REQUIRED
    assert excinfo.value.detail == "insufficient_offerings"


@pytest.mark.asyncio
async def test_preflight_deduction_raises_400_when_user_missing(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A spend miss for a non-existent user must surface ``user_not_found``."""
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "0")
    with pytest.raises(HTTPException) as excinfo:
        await preflight_deduction(db_session, user_id=999)

    assert excinfo.value.status_code == HTTPStatus.BAD_REQUEST
    assert excinfo.value.detail == "user_not_found"


@pytest.mark.asyncio
async def test_add_balance_increments_and_returns_total(db_session: AsyncSession) -> None:
    user = await _make_user(db_session, offering_balance=5)
    assert user.id is not None

    new_total = await add_balance(db_session, user.id, 7)
    await db_session.commit()

    assert new_total == 12
    rows = (await db_session.execute(select(User).where(User.id == user.id))).scalars().all()
    assert rows[0].offering_balance == 12


@pytest.mark.asyncio
async def test_add_balance_returns_none_when_user_missing(db_session: AsyncSession) -> None:
    assert await add_balance(db_session, user_id=999, amount=5) is None


# ── Wallet audit trail (BUG-BM-011) ───────────────────────────────────────


@pytest.mark.asyncio
async def test_spend_monthly_creates_audit_row(db_session: AsyncSession) -> None:
    """A monthly spend records ``actor=user``, ``bucket=monthly``, delta=+1."""
    user = await _make_user(db_session, monthly_used=2, offering_balance=0)
    assert user.id is not None

    await spend_one_message(db_session, user.id, monthly_cap=5)
    await db_session.commit()

    rows = await _audit_rows(db_session, user.id)
    assert len(rows) == 1
    audit = rows[0]
    assert audit.user_id == user.id
    assert audit.actor_user_id == user.id
    assert audit.bucket == BUCKET_MONTHLY
    assert audit.reason == REASON_SPEND_MONTHLY
    # Monthly bucket counts UP, so the delta is +1; before/after walk
    # the seeded ``monthly_used=2`` to ``3``.
    assert audit.delta == Decimal("1.000000")
    assert audit.balance_before == Decimal("2.000000")
    assert audit.balance_after == Decimal("3.000000")


@pytest.mark.asyncio
async def test_spend_offering_creates_audit_row(db_session: AsyncSession) -> None:
    """An offering spend records ``bucket=offering`` and a NEGATIVE delta."""
    user = await _make_user(db_session, monthly_used=5, offering_balance=4)
    assert user.id is not None

    await spend_one_message(db_session, user.id, monthly_cap=5)
    await db_session.commit()

    rows = await _audit_rows(db_session, user.id)
    assert len(rows) == 1
    audit = rows[0]
    assert audit.bucket == BUCKET_OFFERING
    assert audit.reason == REASON_SPEND_OFFERING
    # Offering balance counts DOWN: 4 -> 3, so delta = -1.
    assert audit.delta == Decimal("-1.000000")
    assert audit.balance_before == Decimal("4.000000")
    assert audit.balance_after == Decimal("3.000000")


@pytest.mark.asyncio
async def test_spend_failure_writes_no_audit_row(db_session: AsyncSession) -> None:
    """Both buckets empty: ``spend_one_message`` returns ``None`` and no audit row lands."""
    user = await _make_user(db_session, monthly_used=5, offering_balance=0)
    assert user.id is not None

    assert await spend_one_message(db_session, user.id, monthly_cap=5) is None
    await db_session.commit()

    assert await _audit_rows(db_session, user.id) == []


@pytest.mark.asyncio
async def test_add_balance_records_admin_actor(db_session: AsyncSession) -> None:
    """When an admin grants credits the audit row carries the admin's id as actor."""
    admin = await _make_user(db_session, email="admin@example.com")
    recipient = await _make_user(db_session, email="user@example.com", offering_balance=10)
    assert admin.id is not None
    assert recipient.id is not None

    new_balance = await add_balance(db_session, recipient.id, 25, actor_user_id=admin.id)
    await db_session.commit()
    assert new_balance == 35

    rows = await _audit_rows(db_session, recipient.id)
    assert len(rows) == 1
    audit = rows[0]
    assert audit.user_id == recipient.id
    assert audit.actor_user_id == admin.id  # actor is distinct from recipient
    assert audit.bucket == BUCKET_OFFERING
    assert audit.reason == REASON_ADMIN_GRANT
    assert audit.delta == Decimal("25.000000")
    assert audit.balance_before == Decimal("10.000000")
    assert audit.balance_after == Decimal("35.000000")


@pytest.mark.asyncio
async def test_add_balance_self_grant_records_user_as_actor(db_session: AsyncSession) -> None:
    """Without an explicit actor the audit row defaults to the recipient (legacy callers).

    The reason is ``REASON_SELF_GRANT`` (not ``REASON_ADMIN_GRANT``) so a
    future non-admin call site (Stripe webhook, referral credit) cannot
    silently log itself as an admin grant.
    """
    user = await _make_user(db_session, offering_balance=0)
    assert user.id is not None

    await add_balance(db_session, user.id, 7)
    await db_session.commit()

    rows = await _audit_rows(db_session, user.id)
    assert len(rows) == 1
    assert rows[0].actor_user_id == user.id
    assert rows[0].reason == REASON_SELF_GRANT


@pytest.mark.asyncio
async def test_add_balance_failure_writes_no_audit_row(db_session: AsyncSession) -> None:
    """A grant against a missing user must not insert an orphan audit row."""
    assert await add_balance(db_session, user_id=999, amount=5) is None
    await db_session.commit()
    rows = await _audit_rows(db_session, user_id=999)
    assert rows == []
