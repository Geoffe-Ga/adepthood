"""Contract tests for the zero-payment browser lane's two arrange seams."""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from models import User
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
async def test_exhaust_arrange_moves_only_the_wallet_counters(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The arrange reaches zero remaining balance without inventing an audit spend."""
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "7")
    user = User(
        email="floor@example.com",
        password_hash="not-used",  # pragma: allowlist secret
        offering_balance=3,
    )
    db_session.add(user)
    await db_session.commit()

    receipt = await exhaust(db_session, " FLOOR@example.com ")

    await db_session.refresh(user)
    assert receipt == {
        "monthly_cap": 7,
        "monthly_messages_used": 7,
        "offering_balance": 0,
        "rows": [],
    }
    assert user.monthly_messages_used == 7
    assert user.offering_balance == 0
