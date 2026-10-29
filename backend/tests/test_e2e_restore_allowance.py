"""The e2e lane's allowance restore undoes one account's spending and never grants more."""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from models.user import User
from tests.e2e.restore_allowance import RestoreAllowanceError, _require_database_url, restore
from tests.helpers.feedback_triage import make_account

RECORDED_USED = 4
RECORDED_BALANCE = 2
SPENT_USED = 7
SPENT_BALANCE = 1
BYSTANDER_USED = 9


async def _set_wallet(session: AsyncSession, user_id: int, used: int, balance: int) -> None:
    """Move ``user_id``'s two counters to the given values."""
    user = await session.get(User, user_id)
    assert user is not None
    user.monthly_messages_used = used
    user.offering_balance = balance
    session.add(user)
    await session.commit()


async def _wallet(session: AsyncSession, user_id: int) -> tuple[int, int]:
    """Return ``user_id``'s counters as the database holds them now."""
    session.expire_all()
    user = await session.get(User, user_id)
    assert user is not None
    return user.monthly_messages_used, user.offering_balance


@pytest.mark.asyncio
async def test_restore_undoes_the_spend_on_the_named_account_only(
    db_session: AsyncSession,
) -> None:
    """Both counters return to the recorded wallet; a bystander is untouched."""
    target = await make_account(db_session, "e2e-owner@example.com")
    bystander = await make_account(db_session, "e2e-bystander@example.com")
    await _set_wallet(db_session, target.user_id, SPENT_USED, SPENT_BALANCE)
    await _set_wallet(db_session, bystander.user_id, BYSTANDER_USED, 0)

    receipt = await restore(
        db_session,
        "  E2E-Owner@Example.com ",
        recorded_used=RECORDED_USED,
        recorded_balance=RECORDED_BALANCE,
    )

    assert receipt == {
        "monthly_messages_used": RECORDED_USED,
        "offering_balance": RECORDED_BALANCE,
    }
    assert await _wallet(db_session, target.user_id) == (RECORDED_USED, RECORDED_BALANCE)
    assert await _wallet(db_session, bystander.user_id) == (BYSTANDER_USED, 0)


@pytest.mark.asyncio
async def test_restore_never_grants_capacity_beyond_what_is_held(
    db_session: AsyncSession,
) -> None:
    """A counter already past its recorded value is left where it is."""
    target = await make_account(db_session, "e2e-owner@example.com")
    # A monthly reset landed mid-journey and an operator credit arrived: the
    # account now holds more capacity than was recorded, and keeps exactly that.
    await _set_wallet(db_session, target.user_id, RECORDED_USED - 1, RECORDED_BALANCE + 1)

    await restore(
        db_session,
        "e2e-owner@example.com",
        recorded_used=RECORDED_USED,
        recorded_balance=RECORDED_BALANCE,
    )

    assert await _wallet(db_session, target.user_id) == (RECORDED_USED - 1, RECORDED_BALANCE + 1)


@pytest.mark.asyncio
async def test_restore_refuses_an_address_nobody_holds(db_session: AsyncSession) -> None:
    """A restore that touched nobody must not pass as one that worked."""
    with pytest.raises(RestoreAllowanceError, match="no user is registered"):
        await restore(db_session, "nobody@example.com", recorded_used=0, recorded_balance=0)


@pytest.mark.asyncio
async def test_restore_refuses_a_negative_recording(db_session: AsyncSession) -> None:
    """A negative value is no wallet reading, so nothing is written."""
    target = await make_account(db_session, "e2e-owner@example.com")
    await _set_wallet(db_session, target.user_id, SPENT_USED, SPENT_BALANCE)

    with pytest.raises(RestoreAllowanceError, match="never negative"):
        await restore(db_session, "e2e-owner@example.com", recorded_used=-1, recorded_balance=0)

    assert await _wallet(db_session, target.user_id) == (SPENT_USED, SPENT_BALANCE)


def test_the_database_url_is_required(monkeypatch: pytest.MonkeyPatch) -> None:
    """No URL, no restore -- rather than a default database."""
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(RestoreAllowanceError, match="DATABASE_URL"):
        _require_database_url()
