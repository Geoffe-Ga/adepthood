"""Refund / dispute handling for POST /webhooks/gumroad/ping.

Contract: a ``refund`` or ``dispute`` ping resolves the ORIGINAL stored sale
row (``resource_name == "sale"``, same ``sale_id``) and reverses exactly what
that sale delivered. An APTITUDE sale's ``course_access`` is revoked on the
account its licence binding names — never an account looked up by email (ADR
0008 Decision 4) — and the binding itself survives, so a reactivated sale
cannot drift to a second account. A sale nobody has bound revokes nothing. A
token-pack sale has the full configured pack size clawed back from the
account that actually received the credits, even when that drives the balance
negative. The two reversals are disjoint: a course refund writes no wallet
audit, a pack refund touches no entitlement.

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
from models.license_binding import LicenseBinding
from models.user import User
from models.wallet_audit import (
    BUCKET_OFFERING,
    REASON_GUMROAD_PURCHASE,
    REASON_GUMROAD_REFUND,
    WalletAudit,
)
from schemas.gumroad import GumroadLicenseResult, GumroadPurchase

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
OTHER_EMAIL = "other-buyer@example.com"
RECIPIENT_EMAIL = "gift-recipient@example.com"
SIGNUP_PATH = "/auth/signup"
SIGNUP_PASSWORD = "securepassword123"  # pragma: allowlist secret
LICENSE_KEY = "REFUND-SUITE-LICENSE-KEY"  # pragma: allowlist secret
LICENSE_USES = 1
VERIFY_SEAM = "domain.entitlements.verify_license"
DETAIL_INVALID_LICENSE = "invalid_license"

SALE_ID = "S-100"
SECOND_SALE_ID = "S-101"
PACK_SALE_ID = "S-200"
UNKNOWN_SALE_ID = "S-999"

REFUND_RESOURCE = "refund"
DISPUTE_RESOURCE = "dispute"
CANCELLATION_RESOURCE = "cancellation"

UNKNOWN_SALE_MARKER = "unknown_sale"
SALE_NOT_BOUND_MARKER = "sale_not_bound"
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


async def _bindings(db_session: AsyncSession) -> list[tuple[int, str]]:
    """Return every ``(user_id, sale_id)`` binding, read fresh and ordered by insertion."""
    result = await db_session.execute(
        select(LicenseBinding)
        .order_by(col(LicenseBinding.id))
        .execution_options(populate_existing=True)
    )
    return [(row.user_id, row.gumroad_sale_id) for row in result.scalars().all()]


def _verify_stub_for(sale_id: str) -> object:
    """Build a verify_license stand-in reporting ``LICENSE_KEY`` as ``sale_id``."""

    async def _verify(
        product_id: str,
        license_key: str,
        **_kwargs: object,
    ) -> GumroadLicenseResult | None:
        if license_key != LICENSE_KEY or product_id != APTITUDE_PRODUCT_ID:
            return None
        return GumroadLicenseResult(
            success=True,
            uses=LICENSE_USES,
            purchase=GumroadPurchase(
                email=BUYER_EMAIL,
                product_id=APTITUDE_PRODUCT_ID,
                sale_id=sale_id,
                refunded=False,
                chargebacked=False,
            ),
        )

    return _verify


async def _signup(client: AsyncClient, email: str) -> Response:
    """POST a licence-gated signup for ``email`` with the suite's key."""
    return await client.post(
        SIGNUP_PATH,
        json={"email": email, "password": SIGNUP_PASSWORD, "license_key": LICENSE_KEY},
    )


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
@pytest.mark.real_license_gate
async def test_refund_revokes_the_account_bound_to_the_sale_even_when_its_email_differs(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The refund follows the binding, not the buyer's address (ADR 0008 Decision 4).

    A gift recipient redeemed the key under their own email; the buyer also
    has an account. Refunding the sale revokes the recipient — the account
    that actually holds the access — and leaves the buyer's untouched.
    """
    buyer_id = await _persist_user(db_session)
    monkeypatch.setattr(VERIFY_SEAM, _verify_stub_for(SALE_ID))
    signup = await _signup(async_client, RECIPIENT_EMAIL)
    assert signup.status_code == HTTPStatus.OK
    recipient_id = int(signup.json()["user_id"])
    await _ping(async_client, _sale_payload())

    response = await _ping(async_client, _refund_payload())

    assert response.status_code == HTTPStatus.OK
    entitlement = await _sole_entitlement(db_session)
    assert entitlement.user_id == recipient_id
    assert entitlement.revoked_at is not None
    assert await has_course_access(db_session, buyer_id) is False
    assert await _bindings(db_session) == [(recipient_id, SALE_ID)]


@pytest.mark.asyncio
async def test_refund_of_an_unclaimed_second_sale_touches_nobody(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A member's second purchase is an unbound gift; refunding it revokes no one.

    Under the old email rule this second sale "covered" the first; under the
    binding it is simply a sale nobody has redeemed, so its refund stamps the
    claim and leaves the buyer's own bound access alone.
    """
    caplog.set_level(logging.DEBUG)
    user_id = await _persist_user(db_session)
    await _ping(async_client, _sale_payload())
    second_sale = _sale_payload(sale_id=SECOND_SALE_ID, product_id=SECOND_APTITUDE_PRODUCT_ID)
    await _ping(async_client, second_sale)

    response = await _ping(async_client, {**second_sale, "resource_name": REFUND_RESOURCE})

    assert response.status_code == HTTPStatus.OK
    assert (await _sole_entitlement(db_session)).revoked_at is None
    assert await has_course_access(db_session, user_id) is True
    refunded = await _reload_sale(db_session, SECOND_SALE_ID)
    assert refunded.refunded is True
    assert refunded.revocation_processed_at is not None
    assert await _bindings(db_session) == [(user_id, SALE_ID)]
    assert _log_carries_marker(caplog, SALE_NOT_BOUND_MARKER)


@pytest.mark.asyncio
async def test_refunding_the_bound_sale_revokes_even_with_an_unclaimed_sale_waiting(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An unbound second sale does not keep the bound one's access alive."""
    await _persist_user(db_session)
    await _ping(async_client, _sale_payload())
    await _ping(
        async_client,
        _sale_payload(sale_id=SECOND_SALE_ID, product_id=SECOND_APTITUDE_PRODUCT_ID),
    )

    await _ping(async_client, _refund_payload())

    assert (await _sole_entitlement(db_session)).revoked_at is not None


@pytest.mark.asyncio
async def test_refund_for_a_buyer_who_never_signed_up_is_a_clean_no_op(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A refund can land before anyone redeems the key, and must not blow up.

    An unbound sale granted nothing at purchase time, so the refund has no
    entitlement to revoke. It still has to answer 200 and still has to take
    the claim, so the sale is closed out rather than left waiting for a
    redelivery to reverse an account that may appear later.
    """
    caplog.set_level(logging.DEBUG)
    await _ping(async_client, _sale_payload())

    response = await _ping(async_client, _refund_payload())

    assert response.status_code == HTTPStatus.OK
    assert await _entitlements(db_session) == []
    assert await _refund_audits(db_session) == []
    sale = await _reload_sale(db_session, SALE_ID)
    assert sale.refunded is True
    assert sale.revocation_processed_at is not None
    assert await _bindings(db_session) == []
    assert _log_carries_marker(caplog, SALE_NOT_BOUND_MARKER)


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
    # The binding outlives the revocation (ADR 0008 Decision 4): the sale stays
    # this account's, so a reactivation can never drift to somebody else.
    assert await _bindings(db_session) == [(user_id, SALE_ID)]


@pytest.mark.asyncio
@pytest.mark.real_license_gate
async def test_a_reactivated_sale_stays_bound_to_its_first_account(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """After a refund, nobody else can redeem the key — and the holder cannot self-reinstate.

    Gumroad may report the sale live again; the binding still names the
    first account, so a second account presenting the key gets the generic
    refusal, and the refunded holder presenting it again is a duplicate
    signup rather than a fresh grant.
    """
    monkeypatch.setattr(VERIFY_SEAM, _verify_stub_for(SALE_ID))
    signup = await _signup(async_client, BUYER_EMAIL)
    assert signup.status_code == HTTPStatus.OK
    holder_id = int(signup.json()["user_id"])
    await _ping(async_client, _sale_payload())
    await _ping(async_client, _refund_payload())
    assert await has_course_access(db_session, holder_id) is False

    second_account = await _signup(async_client, OTHER_EMAIL)
    holder_again = await _signup(async_client, BUYER_EMAIL)

    assert second_account.status_code == HTTPStatus.BAD_REQUEST
    assert second_account.json()["detail"] == DETAIL_INVALID_LICENSE
    assert holder_again.status_code == HTTPStatus.BAD_REQUEST
    assert holder_again.json()["detail"] == DETAIL_INVALID_LICENSE
    assert await _bindings(db_session) == [(holder_id, SALE_ID)]
    assert await _active_entitlements(db_session) == []
    users = (await db_session.execute(select(func.count()).select_from(User))).scalar_one()
    assert users == 1


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
