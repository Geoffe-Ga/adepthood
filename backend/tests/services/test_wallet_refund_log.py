"""The structured line a successful refund leaves behind (#623 PR3).

Record §1 asks to "instrument actual input/output tokens, model, cost
estimate, refunds, and cache hits". A refund already writes its ``walletaudit``
row; this pins the log line beside it, ``wallet_refund_applied``, so refunds
are visible in the same stream as the settlement lines. The noop warning that
already existed is unchanged.

A refund is only staged in the caller's transaction, and a rollback erases it,
so the line is written by ``log_committed_refund`` once the caller's commit has
landed, never by staging itself.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from models.user import User
from models.wallet_audit import (
    BUCKET_MONTHLY,
    BUCKET_OFFERING,
    REASON_REFUND_FAILED_ESSAY,
    REASON_REFUND_NO_NOTES,
)
from services.wallet import (
    SpendResult,
    log_committed_refund,
    refund_one_message,
    spend_one_message,
)
from tests.helpers.log_lines import production_line, records_for

_MONTHLY_CAP = 5
_APPLIED = "wallet_refund_applied"
_NOOP = "wallet_refund_noop"


async def _make_user(session: AsyncSession, *, monthly_used: int, offering_balance: int) -> int:
    user = User(
        email=f"refund_log_{monthly_used}_{offering_balance}@example.com",
        password_hash="x",
        monthly_messages_used=monthly_used,
        offering_balance=offering_balance,
        monthly_reset_date=datetime.now(UTC).replace(tzinfo=None) + timedelta(days=30),
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    assert user.id is not None
    return user.id


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("monthly_used", "bucket", "reason"),
    [
        (0, BUCKET_MONTHLY, REASON_REFUND_NO_NOTES),
        (_MONTHLY_CAP, BUCKET_OFFERING, REASON_REFUND_FAILED_ESSAY),
    ],
)
async def test_a_refund_that_lands_logs_one_applied_line(
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
    monthly_used: int,
    bucket: str,
    reason: str,
) -> None:
    """One ``wallet_refund_applied`` per committed refund, naming its bucket and reason.

    Staging alone writes nothing; the line follows the commit.
    """
    user_id = await _make_user(db_session, monthly_used=monthly_used, offering_balance=3)
    spent = await spend_one_message(db_session, user_id, _MONTHLY_CAP)
    assert spent is not None
    assert spent.bucket == bucket
    caplog.set_level(logging.INFO, logger="services.wallet")
    caplog.clear()

    refund = await refund_one_message(db_session, user_id, spent, reason=reason)
    assert records_for(caplog.records, _APPLIED) == []
    await db_session.commit()
    log_committed_refund(refund)

    applied = records_for(caplog.records, _APPLIED)
    assert len(applied) == 1
    record = applied[0]
    assert record.levelno == logging.INFO
    assert record.__dict__["user_id"] == user_id
    assert record.__dict__["bucket"] == bucket
    assert record.__dict__["refund_reason"] == reason
    line = production_line(record)
    assert f"reason={reason}" in line
    assert f"bucket={bucket}" in line
    assert records_for(caplog.records, _NOOP) == []


@pytest.mark.asyncio
async def test_a_refund_with_nothing_to_reverse_logs_only_the_noop(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    """A counter already at zero is a noop: the warning, never an applied line."""
    user_id = await _make_user(db_session, monthly_used=0, offering_balance=0)
    phantom = SpendResult(monthly_used=1, offering_balance=0, bucket=BUCKET_MONTHLY)
    caplog.set_level(logging.INFO, logger="services.wallet")
    caplog.clear()

    returned = await refund_one_message(db_session, user_id, phantom)
    await db_session.commit()
    log_committed_refund(returned)

    assert returned.balances == phantom
    assert returned.landed is False
    assert records_for(caplog.records, _APPLIED) == []
    noops = records_for(caplog.records, _NOOP)
    assert len(noops) == 1
    assert noops[0].levelno == logging.WARNING


def test_no_staged_refund_logs_nothing(caplog: pytest.LogCaptureFixture) -> None:
    """A caller with nothing staged (BYOK, or a pass that kept notes) passes ``None``."""
    caplog.set_level(logging.INFO, logger="services.wallet")
    caplog.clear()

    log_committed_refund(None)

    assert caplog.records == []
