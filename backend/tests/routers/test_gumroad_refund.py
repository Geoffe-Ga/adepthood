"""Refund / dispute handling for POST /webhooks/gumroad/ping.

Contract: a ``refund`` or ``dispute`` ping resolves the ORIGINAL stored sale
row (``resource_name == "sale"``, same ``sale_id``) and reverses exactly what
that sale delivered. An APTITUDE sale loses ``course_access`` unless another
live APTITUDE purchase by the same buyer still covers it; a token-pack sale
has the full configured pack size clawed back from the account that actually
received the credits, even when that drives the balance negative. The two
reversals are disjoint: a course refund writes no wallet audit, a pack refund
touches no entitlement.

Every reversal is claimed exactly once via ``revocation_processed_at``, so a
replayed delivery moves nothing. Nothing in the refund payload steers the
outcome: the product, the amount, and the recipient all come from the stored
sale, so a forged override cannot redirect or inflate the claw-back.
"""

from __future__ import annotations

import logging
from decimal import Decimal
from http import HTTPStatus

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import func, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.entitlements import (
    PRODUCT_IDS_ENV_VAR,
    TOKEN_PACK_PRODUCT_IDS_ENV_VAR,
    TOKEN_PACK_SIZES_ENV_VAR,
    has_course_access,
)
from models.entitlement import Entitlement
from models.gumroad_sale import SALE_RESOURCE_NAME, GumroadSale
from models.user import User
from models.wallet_audit import (
    BUCKET_OFFERING,
    REASON_GUMROAD_PURCHASE,
    REASON_GUMROAD_REFUND,
    WalletAudit,
)

WEBHOOK_PATH = "/webhooks/gumroad/ping"
WEBHOOK_SECRET = "gumroad-refund-shared-secret-test-only"  # pragma: allowlist secret
WRONG_WEBHOOK_SECRET = "not-the-shared-secret"  # pragma: allowlist secret
BLANK_SECRET = ""
WEBHOOK_SECRET_ENV_VAR = "GUMROAD_WEBHOOK_SECRET"  # pragma: allowlist secret

APTITUDE_PRODUCT_ID = "prod_course_abc"
SECOND_APTITUDE_PRODUCT_ID = "prod_course_xyz"
TOKEN_PACK_PRODUCT_ID = "prod_pack_small"
TOKEN_PACK_SIZE = 100

BUYER_EMAIL = "buyer@example.com"
MIXED_CASE_BUYER_EMAIL = "Buyer@Example.COM"
OTHER_EMAIL = "other-buyer@example.com"

SALE_ID = "S-100"
SECOND_SALE_ID = "S-101"
PACK_SALE_ID = "S-200"
UNKNOWN_SALE_ID = "S-999"

REFUND_RESOURCE = "refund"
DISPUTE_RESOURCE = "dispute"
CANCELLATION_RESOURCE = "cancellation"

UNKNOWN_SALE_MARKER = "unknown_sale"
COVERED_MARKER = "covered_by_other_sale"
PREVIOUSLY_REVERSED_MARKER = "sale_previously_reversed"

# The buyer spent part of the pack before charging back, so the full-size
# claw-back has to take the balance below zero.
SPENT_DOWN_BALANCE = 40
NEGATIVE_BALANCE = SPENT_DOWN_BALANCE - TOKEN_PACK_SIZE

# Payload fields a naive implementation might trust over the stored sale.
HOSTILE_QUANTITY = "9999"
HOSTILE_PRICE = "9999"

EXPECTED_SALES_AFTER_ORPHAN_REFUND = 2


@pytest.fixture(autouse=True)
def gumroad_config(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure the shared secret and both product allowlists for every test."""
    monkeypatch.setenv(WEBHOOK_SECRET_ENV_VAR, WEBHOOK_SECRET)
    monkeypatch.setenv(PRODUCT_IDS_ENV_VAR, f"{APTITUDE_PRODUCT_ID},{SECOND_APTITUDE_PRODUCT_ID}")
    monkeypatch.setenv(TOKEN_PACK_PRODUCT_IDS_ENV_VAR, TOKEN_PACK_PRODUCT_ID)
    monkeypatch.setenv(TOKEN_PACK_SIZES_ENV_VAR, f"{TOKEN_PACK_PRODUCT_ID}:{TOKEN_PACK_SIZE}")


def _sale_payload(**overrides: str) -> dict[str, str]:
    """Build a form-encoded APTITUDE sale ping, with optional overrides."""
    payload = {
        "sale_id": SALE_ID,
        "product_id": APTITUDE_PRODUCT_ID,
        "email": BUYER_EMAIL,
        "resource_name": SALE_RESOURCE_NAME,
        "is_recurring_charge": "false",
        "refunded": "false",
    }
    payload.update(overrides)
    return payload


def _pack_payload(**overrides: str) -> dict[str, str]:
    """Build a token-pack sale ping, with optional overrides."""
    defaults = {"sale_id": PACK_SALE_ID, "product_id": TOKEN_PACK_PRODUCT_ID}
    return _sale_payload(**{**defaults, **overrides})


def _refund_payload(**overrides: str) -> dict[str, str]:
    """Build a refund ping for the default APTITUDE sale."""
    return _sale_payload(**{"resource_name": REFUND_RESOURCE, **overrides})


def _pack_refund_payload(**overrides: str) -> dict[str, str]:
    """Build a refund ping for the default token-pack sale."""
    return _pack_payload(**{"resource_name": REFUND_RESOURCE, **overrides})


async def _ping(
    client: AsyncClient,
    payload: dict[str, str],
    secret: str = WEBHOOK_SECRET,
) -> Response:
    """POST one form-encoded ping with the given shared secret."""
    return await client.post(WEBHOOK_PATH, params={"secret": secret}, data=payload)


def _log_carries_marker(caplog: pytest.LogCaptureFixture, marker: str) -> bool:
    """Return True when ``marker`` appears in captured text or as a reason_code."""
    if marker in caplog.text:
        return True
    return any(getattr(record, "reason_code", None) == marker for record in caplog.records)


async def _persist_user(db_session: AsyncSession, email: str = BUYER_EMAIL) -> int:
    """Create and commit a user; return their non-null id.

    Only the id is returned because the handlers under test commit the same
    session, and reading an attribute off a stale instance afterwards would
    lazy-load outside the async context instead of failing an assertion.
    """
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    if user.id is None:
        msg = "user id missing after commit"
        raise RuntimeError(msg)
    return user.id


async def _set_offering_balance(db_session: AsyncSession, user_id: int, balance: int) -> None:
    """Overwrite a user's ``offering_balance`` to simulate prior spending."""
    await db_session.execute(
        update(User)
        .where(col(User.id) == user_id)
        .values(offering_balance=balance)
        .execution_options(synchronize_session=False)
    )
    await db_session.commit()


async def _offering_balance(db_session: AsyncSession, user_id: int) -> int:
    """Return the user's persisted offering balance, read fresh."""
    result = await db_session.execute(
        select(User).where(col(User.id) == user_id).execution_options(populate_existing=True)
    )
    return int(result.scalars().one().offering_balance)


async def _reload_sale(db_session: AsyncSession, sale_id: str) -> GumroadSale:
    """Re-read one sale row from the database, bypassing the identity map."""
    result = await db_session.execute(
        select(GumroadSale)
        .where(col(GumroadSale.gumroad_sale_id) == sale_id)
        .execution_options(populate_existing=True)
    )
    return result.scalars().one()


async def _entitlements(db_session: AsyncSession) -> list[Entitlement]:
    """Return every entitlement row, read fresh and ordered by insertion."""
    result = await db_session.execute(
        select(Entitlement).order_by(col(Entitlement.id)).execution_options(populate_existing=True)
    )
    return list(result.scalars().all())


async def _sole_entitlement(db_session: AsyncSession) -> Entitlement:
    """Return the single entitlement row, failing loudly if there is not exactly one."""
    entitlements = await _entitlements(db_session)
    assert len(entitlements) == 1
    return entitlements[0]


async def _refund_audits(db_session: AsyncSession) -> list[WalletAudit]:
    """Return only the ``gumroad_refund`` audit rows, oldest first."""
    result = await db_session.execute(
        select(WalletAudit)
        .where(col(WalletAudit.reason) == REASON_GUMROAD_REFUND)
        .order_by(col(WalletAudit.id))
        .execution_options(populate_existing=True)
    )
    return list(result.scalars().all())


async def _purchase_audits(db_session: AsyncSession) -> list[WalletAudit]:
    """Return only the ``gumroad_purchase`` audit rows, oldest first."""
    result = await db_session.execute(
        select(WalletAudit)
        .where(col(WalletAudit.reason) == REASON_GUMROAD_PURCHASE)
        .order_by(col(WalletAudit.id))
        .execution_options(populate_existing=True)
    )
    return list(result.scalars().all())


async def _active_entitlements(db_session: AsyncSession) -> list[Entitlement]:
    """Return only the entitlement rows that are still live (``revoked_at`` unset)."""
    return [row for row in await _entitlements(db_session) if row.revoked_at is None]


async def _count_sales(db_session: AsyncSession) -> int:
    """Return the number of GumroadSale rows in the test database."""
    result = await db_session.execute(select(func.count()).select_from(GumroadSale))
    return int(result.scalar_one())


@pytest.mark.asyncio
@pytest.mark.parametrize("resource_name", [REFUND_RESOURCE, DISPUTE_RESOURCE])
async def test_reversal_event_revokes_course_access(
    async_client: AsyncClient,
    db_session: AsyncSession,
    resource_name: str,
) -> None:
    """A refund or a dispute revokes the buyer's course access and marks the sale."""
    user_id = await _persist_user(db_session)
    await _ping(async_client, _sale_payload())

    response = await _ping(async_client, _refund_payload(resource_name=resource_name))

    assert response.status_code == HTTPStatus.OK
    entitlement = await _sole_entitlement(db_session)
    assert entitlement.user_id == user_id
    assert entitlement.revoked_at is not None
    sale = await _reload_sale(db_session, SALE_ID)
    assert sale.refunded is True
    assert sale.revocation_processed_at is not None
    assert await _refund_audits(db_session) == []


@pytest.mark.asyncio
async def test_replayed_refund_revokes_exactly_once(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A redelivered refund keeps one revoked entitlement with an unchanged timestamp."""
    await _persist_user(db_session)
    await _ping(async_client, _sale_payload())

    first = await _ping(async_client, _refund_payload())
    revoked_at = (await _sole_entitlement(db_session)).revoked_at
    claimed_at = (await _reload_sale(db_session, SALE_ID)).revocation_processed_at
    second = await _ping(async_client, _refund_payload())

    assert [first.status_code, second.status_code] == [HTTPStatus.OK, HTTPStatus.OK]
    assert revoked_at is not None
    assert (await _sole_entitlement(db_session)).revoked_at == revoked_at
    assert (await _reload_sale(db_session, SALE_ID)).revocation_processed_at == claimed_at


@pytest.mark.asyncio
async def test_refund_for_an_unknown_sale_changes_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A refund naming a sale_id we never stored is logged and moves nothing."""
    caplog.set_level(logging.DEBUG)
    await _persist_user(db_session)
    await _ping(async_client, _sale_payload())

    response = await _ping(async_client, _refund_payload(sale_id=UNKNOWN_SALE_ID))

    assert response.status_code == HTTPStatus.OK
    assert (await _sole_entitlement(db_session)).revoked_at is None
    original = await _reload_sale(db_session, SALE_ID)
    assert original.refunded is False
    assert original.revocation_processed_at is None
    assert await _count_sales(db_session) == EXPECTED_SALES_AFTER_ORPHAN_REFUND
    assert _log_carries_marker(caplog, UNKNOWN_SALE_MARKER)


@pytest.mark.asyncio
async def test_a_refund_ping_row_never_satisfies_its_own_sale_lookup(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The row a refund ping creates for itself must not read as an original sale.

    An unseen sale_id makes the webhook persist the refund ping verbatim with
    ``resource_name="refund"``. A redelivery of that same ping would then find
    the row it just created, so a lookup that forgets to require
    ``resource_name == "sale"`` would revoke the buyer's unrelated live access.
    """
    caplog.set_level(logging.DEBUG)
    await _persist_user(db_session)
    await _ping(async_client, _sale_payload())
    orphan = _refund_payload(sale_id=UNKNOWN_SALE_ID)

    first = await _ping(async_client, orphan)
    second = await _ping(async_client, orphan)

    assert [first.status_code, second.status_code] == [HTTPStatus.OK, HTTPStatus.OK]
    assert (await _sole_entitlement(db_session)).revoked_at is None
    stored = await _reload_sale(db_session, UNKNOWN_SALE_ID)
    assert stored.resource_name == REFUND_RESOURCE
    assert stored.refunded is False
    assert stored.revocation_processed_at is None
    assert _log_carries_marker(caplog, UNKNOWN_SALE_MARKER)


@pytest.mark.asyncio
async def test_refund_of_a_covered_purchase_keeps_access(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A second live APTITUDE purchase keeps access alive through the refund.

    The covering sale is recorded under a mixed-case spelling of the same
    address, so coverage has to fold email case the way every other Gumroad
    lookup does.
    """
    caplog.set_level(logging.DEBUG)
    await _persist_user(db_session)
    await _ping(async_client, _sale_payload())
    await _ping(
        async_client,
        _sale_payload(
            sale_id=SECOND_SALE_ID,
            product_id=SECOND_APTITUDE_PRODUCT_ID,
            email=MIXED_CASE_BUYER_EMAIL,
        ),
    )

    response = await _ping(async_client, _refund_payload())

    assert response.status_code == HTTPStatus.OK
    assert (await _sole_entitlement(db_session)).revoked_at is None
    refunded_sale = await _reload_sale(db_session, SALE_ID)
    assert refunded_sale.refunded is True
    assert refunded_sale.revocation_processed_at is not None
    assert _log_carries_marker(caplog, COVERED_MARKER)


@pytest.mark.asyncio
async def test_refunding_every_purchase_finally_revokes_access(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An already-refunded sale stops covering, so the last refund revokes."""
    await _persist_user(db_session)
    await _ping(async_client, _sale_payload())
    second_sale = _sale_payload(sale_id=SECOND_SALE_ID, product_id=SECOND_APTITUDE_PRODUCT_ID)
    await _ping(async_client, second_sale)

    await _ping(async_client, _refund_payload())
    assert (await _sole_entitlement(db_session)).revoked_at is None
    await _ping(async_client, {**second_sale, "resource_name": REFUND_RESOURCE})

    assert (await _sole_entitlement(db_session)).revoked_at is not None


@pytest.mark.asyncio
async def test_a_cancelled_sale_no_longer_covers_a_later_refund(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A cancelled purchase keeps ``refunded`` False yet must stop covering.

    Cancellation stamps only the shared claim, so coverage cannot lean on
    ``refunded`` alone — it has to exclude any sale whose revocation was
    already processed.
    """
    await _persist_user(db_session)
    await _ping(async_client, _sale_payload())
    second_sale = _sale_payload(sale_id=SECOND_SALE_ID, product_id=SECOND_APTITUDE_PRODUCT_ID)
    await _ping(async_client, second_sale)

    await _ping(async_client, {**second_sale, "resource_name": CANCELLATION_RESOURCE})
    assert (await _reload_sale(db_session, SECOND_SALE_ID)).refunded is False
    await _ping(async_client, _refund_payload())

    assert (await _sole_entitlement(db_session)).revoked_at is not None


@pytest.mark.asyncio
async def test_another_buyers_purchase_does_not_cover_a_refund(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A live APTITUDE sale belonging to someone else never keeps access alive."""
    await _persist_user(db_session)
    await _ping(async_client, _sale_payload())
    await _ping(
        async_client,
        _sale_payload(
            sale_id=SECOND_SALE_ID,
            product_id=SECOND_APTITUDE_PRODUCT_ID,
            email=OTHER_EMAIL,
        ),
    )

    await _ping(async_client, _refund_payload())

    assert (await _sole_entitlement(db_session)).revoked_at is not None


@pytest.mark.asyncio
async def test_refund_for_a_buyer_who_never_signed_up_is_a_clean_no_op(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A refund can land before the buyer ever registers, and must not blow up.

    A sale for an unknown address grants nothing at purchase time, so the
    refund has no entitlement to revoke. It still has to answer 200 and still
    has to take the claim, so the sale is closed out rather than left waiting
    for a redelivery to reverse an account that may appear later.
    """
    await _ping(async_client, _sale_payload())

    response = await _ping(async_client, _refund_payload())

    assert response.status_code == HTTPStatus.OK
    assert await _entitlements(db_session) == []
    assert await _refund_audits(db_session) == []
    sale = await _reload_sale(db_session, SALE_ID)
    assert sale.refunded is True
    assert sale.revocation_processed_at is not None


@pytest.mark.asyncio
async def test_a_token_pack_purchase_does_not_cover_a_refunded_course_sale(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Buying credits is not buying the course, so it cannot preserve access.

    Doubles as the course-side disjointness check: revoking access writes no
    wallet audit row and leaves the buyer's purchased credits alone.
    """
    user_id = await _persist_user(db_session)
    await _ping(async_client, _sale_payload())
    await _ping(async_client, _pack_payload())

    await _ping(async_client, _refund_payload())

    assert (await _sole_entitlement(db_session)).revoked_at is not None
    assert await _offering_balance(db_session, user_id) == TOKEN_PACK_SIZE
    assert await _refund_audits(db_session) == []


@pytest.mark.asyncio
async def test_token_pack_refund_claws_back_the_full_pack(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A pack refund debits the configured size once, with a reconciling audit row."""
    user_id = await _persist_user(db_session)
    await _ping(async_client, _pack_payload())
    assert await _offering_balance(db_session, user_id) == TOKEN_PACK_SIZE

    response = await _ping(async_client, _pack_refund_payload())

    assert response.status_code == HTTPStatus.OK
    assert await _offering_balance(db_session, user_id) == 0
    audits = await _refund_audits(db_session)
    assert len(audits) == 1
    assert audits[0].user_id == user_id
    assert audits[0].bucket == BUCKET_OFFERING
    assert audits[0].delta == Decimal(-TOKEN_PACK_SIZE)
    assert audits[0].balance_before == Decimal(TOKEN_PACK_SIZE)
    assert audits[0].balance_after == Decimal(0)
    sale = await _reload_sale(db_session, PACK_SALE_ID)
    assert sale.refunded is True
    assert sale.revocation_processed_at is not None


@pytest.mark.asyncio
async def test_token_pack_refund_may_drive_the_balance_negative(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Credits already spent still come back in full, overdrawing the wallet.

    A chargeback reverses the whole purchase; clamping at zero would let a
    buyer keep the messages they spent before disputing the charge.
    """
    user_id = await _persist_user(db_session)
    await _ping(async_client, _pack_payload())
    await _set_offering_balance(db_session, user_id, SPENT_DOWN_BALANCE)

    response = await _ping(async_client, _pack_refund_payload())

    assert response.status_code == HTTPStatus.OK
    assert await _offering_balance(db_session, user_id) == NEGATIVE_BALANCE
    audits = await _refund_audits(db_session)
    assert len(audits) == 1
    assert audits[0].delta == Decimal(-TOKEN_PACK_SIZE)
    assert audits[0].balance_before == Decimal(SPENT_DOWN_BALANCE)
    assert audits[0].balance_after == Decimal(NEGATIVE_BALANCE)


@pytest.mark.asyncio
async def test_replayed_token_pack_refund_claws_back_exactly_once(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A redelivered pack refund writes no second audit row and moves no credits."""
    user_id = await _persist_user(db_session)
    await _ping(async_client, _pack_payload())

    first = await _ping(async_client, _pack_refund_payload())
    second = await _ping(async_client, _pack_refund_payload())

    assert [first.status_code, second.status_code] == [HTTPStatus.OK, HTTPStatus.OK]
    assert await _offering_balance(db_session, user_id) == 0
    assert len(await _refund_audits(db_session)) == 1


@pytest.mark.asyncio
async def test_refund_claws_back_from_the_account_that_received_the_credits(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The debit follows the stored credit recipient, not the refund's email field."""
    buyer_id = await _persist_user(db_session)
    other_id = await _persist_user(db_session, OTHER_EMAIL)
    await _ping(async_client, _pack_payload())
    await _set_offering_balance(db_session, other_id, SPENT_DOWN_BALANCE)

    await _ping(async_client, _pack_refund_payload(email=OTHER_EMAIL))

    assert await _offering_balance(db_session, buyer_id) == 0
    assert await _offering_balance(db_session, other_id) == SPENT_DOWN_BALANCE
    audits = await _refund_audits(db_session)
    assert len(audits) == 1
    assert audits[0].user_id == buyer_id


@pytest.mark.asyncio
async def test_refund_payload_overrides_cannot_change_the_claw_back(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A forged product, quantity, and price are ignored in favour of the stored sale."""
    user_id = await _persist_user(db_session)
    await _ping(async_client, _pack_payload())

    response = await _ping(
        async_client,
        _pack_refund_payload(
            product_id=APTITUDE_PRODUCT_ID,
            quantity=HOSTILE_QUANTITY,
            price=HOSTILE_PRICE,
        ),
    )

    assert response.status_code == HTTPStatus.OK
    assert await _offering_balance(db_session, user_id) == 0
    audits = await _refund_audits(db_session)
    assert len(audits) == 1
    assert audits[0].delta == Decimal(-TOKEN_PACK_SIZE)
    assert await _entitlements(db_session) == []


@pytest.mark.asyncio
async def test_token_pack_refund_leaves_course_access_intact(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Reversing a credit purchase never disturbs the buyer's course entitlement."""
    user_id = await _persist_user(db_session)
    await _ping(async_client, _sale_payload())
    await _ping(async_client, _pack_payload())

    await _ping(async_client, _pack_refund_payload())

    assert (await _sole_entitlement(db_session)).revoked_at is None
    assert await _offering_balance(db_session, user_id) == 0


@pytest.mark.asyncio
async def test_a_replayed_sale_ping_does_not_reinstate_refunded_access(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A redelivered original sale ping must never undo a completed refund.

    Gumroad re-delivers any ping it believes went unacknowledged, so the
    original purchase event can land again long after the money went back.
    The grant is only idempotent against an *active* entitlement, and the
    refund deliberately freed that slot, so re-dispatching the sale mints a
    brand-new live row and hands a refunded buyer both their money and their
    course access.
    """
    caplog.set_level(logging.DEBUG)
    user_id = await _persist_user(db_session)
    original_sale = _sale_payload()
    await _ping(async_client, original_sale)
    await _ping(async_client, _refund_payload())
    claimed_at = (await _reload_sale(db_session, SALE_ID)).revocation_processed_at

    response = await _ping(async_client, original_sale)

    assert await _active_entitlements(db_session) == []
    assert await has_course_access(db_session, user_id) is False
    assert len(await _entitlements(db_session)) == 1
    assert response.status_code == HTTPStatus.OK
    assert claimed_at is not None
    assert (await _reload_sale(db_session, SALE_ID)).revocation_processed_at == claimed_at
    assert _log_carries_marker(caplog, PREVIOUSLY_REVERSED_MARKER)


@pytest.mark.asyncio
async def test_a_replayed_pack_sale_after_a_refund_credits_nothing_further(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The wallet's one-way credit gate survives a replayed, already-refunded pack sale.

    ``token_pack_credited_at`` is stamped permanently and no reversal clears
    it, so the money side is already immune to the redelivery that reinstates
    course access. Pinned here so narrowing the course grant cannot loosen
    this gate on the way past.
    """
    user_id = await _persist_user(db_session)
    original_pack_sale = _pack_payload()
    await _ping(async_client, original_pack_sale)
    await _ping(async_client, _pack_refund_payload())

    response = await _ping(async_client, original_pack_sale)

    assert response.status_code == HTTPStatus.OK
    assert await _offering_balance(db_session, user_id) == 0
    assert len(await _purchase_audits(db_session)) == 1
    assert len(await _refund_audits(db_session)) == 1
    assert await _entitlements(db_session) == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "secret", [WRONG_WEBHOOK_SECRET, BLANK_SECRET], ids=["wrong_secret", "blank_secret"]
)
async def test_forged_refund_is_rejected_and_changes_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    secret: str,
) -> None:
    """An unauthenticated refund is a 401 that reverses neither access nor credits."""
    user_id = await _persist_user(db_session)
    await _ping(async_client, _sale_payload())
    await _ping(async_client, _pack_payload())

    response = await _ping(async_client, _pack_refund_payload(), secret=secret)

    assert response.status_code == HTTPStatus.UNAUTHORIZED
    assert (await _sole_entitlement(db_session)).revoked_at is None
    assert await _offering_balance(db_session, user_id) == TOKEN_PACK_SIZE
    assert await _refund_audits(db_session) == []
    sale = await _reload_sale(db_session, PACK_SALE_ID)
    assert sale.refunded is False
    assert sale.revocation_processed_at is None
