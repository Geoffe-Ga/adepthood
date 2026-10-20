"""Contract tests for the zero-payment browser lane's two arrange seams."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from models import User
from services.wallet import has_generation_capacity
from tests.e2e.exhaust_allowance import exhaust
from tests.e2e.server import _stub_license_check


@pytest.mark.asyncio
async def test_lane_license_purchase_is_explicitly_zero_price() -> None:
    """The browser's verified purchase says zero rather than omitting price."""
    check = await _stub_license_check("free-floor-key")

    assert check.purchase is not None
    purchase_extra = check.purchase.model_extra
    assert purchase_extra is not None
    assert purchase_extra["price"] == 0


@pytest.mark.asyncio
async def test_exhaust_arrange_blocks_admission_across_immediate_year_rollover(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The arrange reaches zero remaining balance without inventing an audit spend."""
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "7")
    user = User(
        email="floor@example.com",
        password_hash="not-used",  # pragma: allowlist secret
        offering_balance=3,
        monthly_reset_date=datetime.now(UTC) - timedelta(days=1),
    )
    db_session.add(user)
    await db_session.commit()
    assert user.id is not None

    arranged_at = datetime(2026, 12, 31, 23, 59, 59, 999_999, tzinfo=UTC)
    receipt = await exhaust(db_session, " FLOOR@example.com ", now=arranged_at)

    await db_session.refresh(user)
    assert {key: value for key, value in receipt.items() if key != "monthly_reset_date"} == {
        "monthly_cap": 7,
        "monthly_messages_used": 7,
        "offering_balance": 0,
        "rows": [],
    }
    assert user.monthly_messages_used == 7
    reset = user.monthly_reset_date
    if reset.tzinfo is None:
        reset = reset.replace(tzinfo=UTC)
    assert reset == datetime(2027, 2, 1, tzinfo=UTC)
    assert datetime.fromisoformat(str(receipt["monthly_reset_date"])) == reset
    assert user.offering_balance == 0
    just_after_immediate_rollover = datetime(2027, 1, 1, tzinfo=UTC) + timedelta(seconds=1)
    assert not await has_generation_capacity(db_session, user.id, now=just_after_immediate_rollover)
