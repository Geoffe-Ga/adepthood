"""The license-claim seam: one Gumroad sale binds to exactly one active account.

ADR 0008 Decisions 2-4 in test form. The database — not an application
pre-check — refuses a second binding for the same sale; a single account may
hold bindings for as many distinct sales as it has redeemed; and the claim
itself is staged, never committed, so the router can make User + binding +
Entitlement one transaction.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.entitlements import REASON_LICENSE_ALREADY_BOUND, REASON_SIGNUP_REDEMPTION
from domain.license_claims import (
    ClaimOutcome,
    bound_elsewhere,
    claim_license,
    find_binding,
    new_claim_refused,
    stage_license_claim,
)
from models.entitlement import Entitlement
from models.gumroad_sale import SALE_RESOURCE_NAME, GumroadSale
from models.license_binding import LicenseBinding
from models.user import User

USER_EMAIL = "seeker@example.com"
OTHER_EMAIL = "someone-else@example.com"
SALE_ID = "S-900"
SECOND_SALE_ID = "S-901"
PRODUCT_ID = "prod_alpha"
DISTINCT_SALE_COUNT = 2
FIND_BINDING_SEAM = "domain.license_claims.find_binding"
BOUND_EVENT = "license_bound"
REJECTED_EVENT = "license_claim_rejected"
REASON_PREVIOUSLY_REVERSED = "sale_previously_reversed"


async def _persist_user(db_session: AsyncSession, email: str = USER_EMAIL) -> tuple[User, int]:
    """Create and commit a user; return the row plus its non-null id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    if user.id is None:
        msg = "user id missing after commit"
        raise RuntimeError(msg)
    return user, user.id


async def _count_bindings(db_session: AsyncSession) -> int:
    """Return the number of LicenseBinding rows in the test database."""
    result = await db_session.execute(select(func.count()).select_from(LicenseBinding))
    return int(result.scalar_one())


@pytest.mark.asyncio
async def test_second_binding_for_the_same_sale_is_rejected_by_the_unique_constraint(
    db_session: AsyncSession,
) -> None:
    """The database, not a pre-check, keeps one sale on one account."""
    _first, first_id = await _persist_user(db_session)
    _second, second_id = await _persist_user(db_session, OTHER_EMAIL)
    db_session.add(LicenseBinding(user_id=first_id, gumroad_sale_id=SALE_ID, product_id=PRODUCT_ID))
    await db_session.commit()

    db_session.add(
        LicenseBinding(user_id=second_id, gumroad_sale_id=SALE_ID, product_id=PRODUCT_ID)
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()

    assert await _count_bindings(db_session) == 1


@pytest.mark.asyncio
async def test_one_account_may_hold_bindings_for_distinct_sales(
    db_session: AsyncSession,
) -> None:
    """Uniqueness is per sale: a buyer who redeemed two receipts keeps both."""
    _user, user_id = await _persist_user(db_session)
    db_session.add(LicenseBinding(user_id=user_id, gumroad_sale_id=SALE_ID, product_id=PRODUCT_ID))
    db_session.add(
        LicenseBinding(user_id=user_id, gumroad_sale_id=SECOND_SALE_ID, product_id=PRODUCT_ID)
    )
    await db_session.commit()

    assert await _count_bindings(db_session) == DISTINCT_SALE_COUNT


async def _count_entitlements(db_session: AsyncSession) -> int:
    """Return the number of Entitlement rows in the test database."""
    result = await db_session.execute(select(func.count()).select_from(Entitlement))
    return int(result.scalar_one())


async def _active_entitlements(db_session: AsyncSession, user_id: int) -> list[Entitlement]:
    """Return the user's live entitlement rows, read fresh."""
    result = await db_session.execute(
        select(Entitlement)
        .where(col(Entitlement.user_id) == user_id, col(Entitlement.revoked_at).is_(None))
        .execution_options(populate_existing=True)
    )
    return list(result.scalars().all())


async def _persist_sale(db_session: AsyncSession, *, reversed_sale: bool = False) -> int:
    """Persist the stored webhook row for ``SALE_ID`` and return its id."""
    sale = GumroadSale(
        gumroad_sale_id=SALE_ID,
        product_id=PRODUCT_ID,
        email=OTHER_EMAIL,
        resource_name=SALE_RESOURCE_NAME,
        raw_payload={"sale_id": SALE_ID},
        revocation_processed_at=datetime.now(UTC) if reversed_sale else None,
    )
    db_session.add(sale)
    await db_session.commit()
    await db_session.refresh(sale)
    if sale.id is None:
        msg = "sale id missing after commit"
        raise RuntimeError(msg)
    return sale.id


def _records_for(caplog: pytest.LogCaptureFixture, event: str) -> list[logging.LogRecord]:
    """Return the captured records whose message is ``event``."""
    return [record for record in caplog.records if record.getMessage() == event]


@pytest.mark.asyncio
async def test_stage_claim_binds_an_unbound_sale_and_stages_one_entitlement(
    db_session: AsyncSession,
) -> None:
    """A first claim stages the binding and the grant without committing either."""
    user, user_id = await _persist_user(db_session)

    outcome = await stage_license_claim(
        db_session,
        user,
        sale_id=SALE_ID,
        product_id=PRODUCT_ID,
    )
    assert outcome is ClaimOutcome.BOUND
    await db_session.commit()

    binding = await find_binding(db_session, SALE_ID)
    assert binding is not None
    assert binding.user_id == user_id
    assert binding.product_id == PRODUCT_ID
    entitlements = await _active_entitlements(db_session, user_id)
    assert len(entitlements) == 1
    assert entitlements[0].product_id == PRODUCT_ID
    assert entitlements[0].source_sale_id is None


@pytest.mark.asyncio
async def test_stage_claim_links_the_stored_sale_when_it_exists(
    db_session: AsyncSession,
) -> None:
    """When the webhook beat the claim, the entitlement points at the stored sale."""
    user, user_id = await _persist_user(db_session)
    sale_row_id = await _persist_sale(db_session)

    outcome = await stage_license_claim(
        db_session,
        user,
        sale_id=SALE_ID,
        product_id=PRODUCT_ID,
    )
    await db_session.commit()

    assert outcome is ClaimOutcome.BOUND
    entitlements = await _active_entitlements(db_session, user_id)
    assert len(entitlements) == 1
    assert entitlements[0].source_sale_id == sale_row_id


@pytest.mark.asyncio
async def test_stage_claim_from_the_bound_account_is_idempotent(
    db_session: AsyncSession,
) -> None:
    """Re-presenting a key from its own account adds no binding and no second grant."""
    user, user_id = await _persist_user(db_session)
    await claim_license(
        db_session,
        user,
        sale_id=SALE_ID,
        product_id=PRODUCT_ID,
        reason_code=REASON_SIGNUP_REDEMPTION,
    )

    outcome = await claim_license(
        db_session,
        user,
        sale_id=SALE_ID,
        product_id=PRODUCT_ID,
        reason_code=REASON_SIGNUP_REDEMPTION,
    )

    assert outcome is ClaimOutcome.ALREADY_OWN
    assert await _count_bindings(db_session) == 1
    assert await _count_entitlements(db_session) == 1
    assert len(await _active_entitlements(db_session, user_id)) == 1


@pytest.mark.asyncio
async def test_stage_claim_from_another_account_is_bound_elsewhere_and_writes_nothing(
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A second account presenting a bound key is refused before anything is staged."""
    caplog.set_level(logging.DEBUG)
    first, _first_id = await _persist_user(db_session)
    second, second_id = await _persist_user(db_session, OTHER_EMAIL)
    await claim_license(
        db_session,
        first,
        sale_id=SALE_ID,
        product_id=PRODUCT_ID,
        reason_code=REASON_SIGNUP_REDEMPTION,
    )

    outcome = await stage_license_claim(
        db_session,
        second,
        sale_id=SALE_ID,
        product_id=PRODUCT_ID,
    )
    await db_session.commit()

    assert outcome is ClaimOutcome.BOUND_ELSEWHERE
    assert await _count_bindings(db_session) == 1
    assert await _active_entitlements(db_session, second_id) == []
    rejected = _records_for(caplog, REJECTED_EVENT)
    assert len(rejected) == 1
    assert rejected[0].levelno == logging.WARNING
    assert getattr(rejected[0], "reason_code", None) == REASON_LICENSE_ALREADY_BOUND
    assert getattr(rejected[0], "user_id", None) == second_id


@pytest.mark.asyncio
async def test_claim_license_losing_the_unique_race_rolls_back_to_bound_elsewhere(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A rival that commits between the lookup and the insert loses nothing to us.

    The pre-check is silenced so the insert reaches the UNIQUE constraint,
    which is the only line of defence that matters under real concurrency.
    """
    first, _first_id = await _persist_user(db_session)
    second, second_id = await _persist_user(db_session, OTHER_EMAIL)
    await claim_license(
        db_session,
        first,
        sale_id=SALE_ID,
        product_id=PRODUCT_ID,
        reason_code=REASON_SIGNUP_REDEMPTION,
    )
    monkeypatch.setattr(FIND_BINDING_SEAM, AsyncMock(return_value=None))

    outcome = await claim_license(
        db_session,
        second,
        sale_id=SALE_ID,
        product_id=PRODUCT_ID,
        reason_code=REASON_SIGNUP_REDEMPTION,
    )

    assert outcome is ClaimOutcome.BOUND_ELSEWHERE
    assert await _count_bindings(db_session) == 1
    assert await _active_entitlements(db_session, second_id) == []
    assert await _count_entitlements(db_session) == 1


@pytest.mark.asyncio
async def test_claim_logs_ids_only(
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The bound line carries the reason and row ids — never an address or a key."""
    caplog.set_level(logging.DEBUG)
    user, user_id = await _persist_user(db_session)

    outcome = await claim_license(
        db_session,
        user,
        sale_id=SALE_ID,
        product_id=PRODUCT_ID,
        reason_code=REASON_SIGNUP_REDEMPTION,
    )

    assert outcome is ClaimOutcome.BOUND
    bound = _records_for(caplog, BOUND_EVENT)
    assert len(bound) == 1
    binding = await find_binding(db_session, SALE_ID)
    assert binding is not None
    assert getattr(bound[0], "reason_code", None) == REASON_SIGNUP_REDEMPTION
    assert getattr(bound[0], "user_id", None) == user_id
    assert getattr(bound[0], "binding_id", None) == binding.id
    assert isinstance(getattr(bound[0], "entitlement_id", None), int)
    # The record's whole attribute bag, not just the message: an address or a
    # key smuggled in through ``extra`` would never show up in the message.
    assert "@" not in repr(vars(bound[0]))


@pytest.mark.asyncio
async def test_bound_elsewhere_answers_for_a_claimant_with_no_account_yet(
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The creation-path pre-check: unbound is free, bound is refused and logged."""
    caplog.set_level(logging.DEBUG)
    holder, holder_id = await _persist_user(db_session)
    assert await bound_elsewhere(db_session, SALE_ID) is False
    await claim_license(
        db_session,
        holder,
        sale_id=SALE_ID,
        product_id=PRODUCT_ID,
        reason_code=REASON_SIGNUP_REDEMPTION,
    )

    refused = await bound_elsewhere(db_session, SALE_ID)
    own = await bound_elsewhere(db_session, SALE_ID, claimant_id=holder_id)

    assert refused is True
    assert own is False
    rejected = _records_for(caplog, REJECTED_EVENT)
    assert len(rejected) == 1
    assert rejected[0].levelno == logging.WARNING
    assert getattr(rejected[0], "reason_code", None) == REASON_LICENSE_ALREADY_BOUND
    assert getattr(rejected[0], "user_id", "missing") is None
    assert "@" not in repr(vars(rejected[0]))


@pytest.mark.asyncio
async def test_a_reversed_sale_refuses_every_new_claimant(
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A sale whose reversal claim is spent is not claimable, bound or not (ADR 0008 D4).

    Gumroad's verify keeps answering ``success`` for an ended subscription, so
    the stored sale's own reversal stamp is the only thing standing between a
    lapsed key and a fresh grant — including after the holder deletes their
    account and the binding goes with it.
    """
    caplog.set_level(logging.DEBUG)
    await _persist_sale(db_session, reversed_sale=True)

    assert await new_claim_refused(db_session, SALE_ID) is True
    assert await bound_elsewhere(db_session, SALE_ID) is False
    rejected = _records_for(caplog, REJECTED_EVENT)
    assert [getattr(record, "reason_code", None) for record in rejected] == [
        REASON_PREVIOUSLY_REVERSED
    ]


@pytest.mark.asyncio
async def test_new_claim_refused_folds_the_bound_check_in(db_session: AsyncSession) -> None:
    """An unbound live sale is claimable; a bound one is refused through the same gate."""
    user, _user_id = await _persist_user(db_session)
    assert await new_claim_refused(db_session, SALE_ID) is False
    await claim_license(
        db_session,
        user,
        sale_id=SALE_ID,
        product_id=PRODUCT_ID,
        reason_code=REASON_SIGNUP_REDEMPTION,
    )

    assert await new_claim_refused(db_session, SALE_ID) is True
