"""Sale-event dispatch tests for POST /webhooks/gumroad/ping.

Contract: an authenticated sale ping grants through the licence binding
(ADR 0008). A sale already bound to an account grants that account and no
other, however many times it is redelivered. An unbound sale is auto-claimed
for the account registered under the buyer's email (matched
case-insensitively) only when that account holds no active course access —
the re-purchase-after-refund shape; a buyer who already has access is buying
a gift, so the sale is left unclaimed for whoever redeems the key. With no
matching user only the sale row is persisted; a later license-gated signup
converges by binding the sale and linking its entitlement to the stored row;
non-sale events never grant.

The token-pack branch is exercised alongside it: a sale of an allowlisted
token-pack product credits the buyer's offering wallet exactly once, by the
configured pack size only, and never grants course access - the two product
allowlists dispatch to disjoint side effects.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.entitlements import TOKEN_PACK_PRODUCT_IDS_ENV_VAR, TOKEN_PACK_SIZES_ENV_VAR
from models.entitlement import Entitlement
from models.gumroad_sale import GumroadSale
from models.license_binding import LicenseBinding
from models.user import User
from models.vault_activation import VaultActivation
from models.wallet_audit import REASON_GUMROAD_PURCHASE, WalletAudit
from schemas.gumroad import GumroadLicenseResult, GumroadPurchase

pytestmark = pytest.mark.real_license_gate

WEBHOOK_PATH = "/webhooks/gumroad/ping"
WEBHOOK_SECRET = "gumroad-webhook-shared-secret-test-only"  # pragma: allowlist secret
SIGNUP_PATH = "/auth/signup"
PRODUCT_IDS_ENV = "GUMROAD_APTITUDE_PRODUCT_IDS"
VERIFY_SEAM = "domain.entitlements.verify_license"
BUYER_EMAIL = "buyer@example.com"
MIXED_CASE_BUYER_EMAIL = "Buyer@Example.COM"
RECIPIENT_EMAIL = "gift-recipient@example.com"
SALE_ID = "S-100"
GIFT_SALE_ID = "S-101"
PRODUCT_ID = "prod_abc123"
OFF_ALLOWLIST_PRODUCT_ID = "prod_token_packs"
NON_SALE_RESOURCE = "refund"
LICENSE_KEY = "WEBHOOK-CONVERGENCE-TEST-KEY"  # pragma: allowlist secret
SIGNUP_PASSWORD = "securepassword123"  # pragma: allowlist secret
COURSE_ACCESS_KIND = "course_access"
LICENSE_USES = 1
WEBHOOK_SALE_MARKER = "webhook_sale"
LEFT_UNCLAIMED_MARKER = "sale_left_unclaimed"
TOKEN_PACK_PRODUCT_ID = "prod_pack_small"
UNSIZED_TOKEN_PACK_PRODUCT_ID = "prod_pack_unsized"
UNKNOWN_PRODUCT_ID = "prod_not_sold_here"
TOKEN_PACK_SIZE = 100
TOKEN_PACK_SALE_ID = "S-200"
UNKNOWN_PRODUCT_MARKER = "unknown_product"
REFUNDED_SALE_MARKER = "refunded_sale"
UNCONFIGURED_SIZE_MARKER = "token_pack_size_unconfigured"
WRONG_WEBHOOK_SECRET = "not-the-shared-secret"  # pragma: allowlist secret
# A payload field a naive implementation might trust; the credit must come
# from the configured pack size alone.
PAYLOAD_QUANTITY_FIELD = "quantity"
PAYLOAD_QUANTITY_VALUE = "9999"


@pytest.fixture
def webhook_secret(monkeypatch: pytest.MonkeyPatch) -> str:
    """Set GUMROAD_WEBHOOK_SECRET for the duration of a test."""
    monkeypatch.setenv("GUMROAD_WEBHOOK_SECRET", WEBHOOK_SECRET)
    return WEBHOOK_SECRET


@pytest.fixture(autouse=True)
def aptitude_allowlist(monkeypatch: pytest.MonkeyPatch) -> str:
    """Put the sale's product on the APTITUDE allowlist for the whole suite.

    The webhook grant path filters the ping's ``product_id`` against
    ``GUMROAD_APTITUDE_PRODUCT_IDS`` — the same allowlist the signup path
    enforces — so a grant only happens for an APTITUDE product. Every
    grant-expecting test here therefore needs the sale product allowlisted;
    off-allowlist behaviour is asserted with a product left off this list.
    """
    monkeypatch.setenv(PRODUCT_IDS_ENV, PRODUCT_ID)
    return PRODUCT_ID


def _sale_payload(**overrides: str) -> dict[str, str]:
    """Build a form-encoded Gumroad ping payload, with optional overrides."""
    payload = {
        "sale_id": SALE_ID,
        "product_id": PRODUCT_ID,
        "email": BUYER_EMAIL,
        "resource_name": "sale",
        "is_recurring_charge": "false",
        "refunded": "false",
    }
    payload.update(overrides)
    return payload


def _log_carries_marker(caplog: pytest.LogCaptureFixture, marker: str) -> bool:
    """Return True when ``marker`` appears in captured text or as a reason_code."""
    if marker in caplog.text:
        return True
    return any(getattr(record, "reason_code", None) == marker for record in caplog.records)


def _make_success_stub(
    sale_id: str = SALE_ID,
) -> Callable[..., Awaitable[GumroadLicenseResult | None]]:
    """Build a verify_license stand-in that reports ``LICENSE_KEY`` as ``sale_id``."""

    async def _verify(
        product_id: str,
        license_key: str,
        **_kwargs: object,
    ) -> GumroadLicenseResult | None:
        assert license_key == LICENSE_KEY
        if product_id != PRODUCT_ID:
            return None
        return GumroadLicenseResult(
            success=True,
            uses=LICENSE_USES,
            purchase=GumroadPurchase(
                email=BUYER_EMAIL,
                product_id=PRODUCT_ID,
                sale_id=sale_id,
                refunded=False,
                chargebacked=False,
            ),
        )

    return _verify


async def _signup_with_license(client: AsyncClient, email: str) -> int:
    """Redeem ``LICENSE_KEY`` for a new account under ``email``; return its id."""
    response = await client.post(
        SIGNUP_PATH,
        json={"email": email, "password": SIGNUP_PASSWORD, "license_key": LICENSE_KEY},
    )
    assert response.status_code == HTTPStatus.OK
    return int(response.json()["user_id"])


async def _persist_user(db_session: AsyncSession, email: str = BUYER_EMAIL) -> tuple[User, int]:
    """Create and commit a user; return the row plus its non-null id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    if user.id is None:
        msg = "user id missing after commit"
        raise RuntimeError(msg)
    return user, user.id


async def _count_sales(db_session: AsyncSession) -> int:
    """Return the number of GumroadSale rows in the test database."""
    result = await db_session.execute(select(func.count()).select_from(GumroadSale))
    return int(result.scalar_one())


async def _count_entitlements(db_session: AsyncSession) -> int:
    """Return the number of Entitlement rows in the test database."""
    result = await db_session.execute(select(func.count()).select_from(Entitlement))
    return int(result.scalar_one())


async def _active_entitlements_of(db_session: AsyncSession, user_id: int) -> int:
    """Return how many live course_access rows ``user_id`` holds, read fresh."""
    result = await db_session.execute(
        select(func.count())
        .select_from(Entitlement)
        .where(col(Entitlement.user_id) == user_id, col(Entitlement.revoked_at).is_(None))
    )
    return int(result.scalar_one())


async def _bindings(db_session: AsyncSession) -> list[LicenseBinding]:
    """Return every binding row, read fresh."""
    result = await db_session.execute(
        select(LicenseBinding).execution_options(populate_existing=True)
    )
    return list(result.scalars().all())


@pytest.mark.asyncio
async def test_sale_ping_grants_entitlement_to_existing_user(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A sale ping for a registered email grants an active linked entitlement."""
    caplog.set_level(logging.DEBUG)
    _user, user_id = await _persist_user(db_session)

    response = await async_client.post(
        WEBHOOK_PATH, params={"secret": webhook_secret}, data=_sale_payload()
    )

    assert response.status_code == HTTPStatus.OK
    sale_row = (await db_session.execute(select(GumroadSale))).scalar_one()
    entitlement = (await db_session.execute(select(Entitlement))).scalar_one()
    assert entitlement.user_id == user_id
    assert entitlement.kind == COURSE_ACCESS_KIND
    assert entitlement.source_sale_id == sale_row.id
    assert entitlement.revoked_at is None
    binding = (await db_session.execute(select(LicenseBinding))).scalar_one()
    assert binding.user_id == user_id
    assert binding.gumroad_sale_id == SALE_ID
    assert binding.product_id == PRODUCT_ID
    assert (await db_session.execute(select(VaultActivation))).scalars().all() == []
    assert _log_carries_marker(caplog, WEBHOOK_SALE_MARKER)


@pytest.mark.asyncio
async def test_replayed_sale_ping_keeps_a_single_entitlement(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
) -> None:
    """Replaying an identical sale ping stays 200 and never duplicates the grant."""
    _user, _user_id = await _persist_user(db_session)
    payload = _sale_payload()

    first = await async_client.post(WEBHOOK_PATH, params={"secret": webhook_secret}, data=payload)
    second = await async_client.post(WEBHOOK_PATH, params={"secret": webhook_secret}, data=payload)

    assert first.status_code == HTTPStatus.OK
    assert second.status_code == HTTPStatus.OK
    assert await _count_sales(db_session) == 1
    assert await _count_entitlements(db_session) == 1


@pytest.mark.asyncio
async def test_sale_ping_email_match_is_case_insensitive(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
) -> None:
    """A mixed-case buyer email still matches the lowercased stored user email."""
    _user, user_id = await _persist_user(db_session)

    response = await async_client.post(
        WEBHOOK_PATH,
        params={"secret": webhook_secret},
        data=_sale_payload(email=MIXED_CASE_BUYER_EMAIL),
    )

    assert response.status_code == HTTPStatus.OK
    entitlement = (await db_session.execute(select(Entitlement))).scalar_one()
    assert entitlement.user_id == user_id
    assert entitlement.kind == COURSE_ACCESS_KIND


@pytest.mark.asyncio
async def test_sale_ping_without_user_persists_sale_only(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
) -> None:
    """With no matching user the ping stores the sale row and grants nothing."""
    response = await async_client.post(
        WEBHOOK_PATH, params={"secret": webhook_secret}, data=_sale_payload()
    )

    assert response.status_code == HTTPStatus.OK
    assert await _count_sales(db_session) == 1
    assert await _count_entitlements(db_session) == 0


@pytest.mark.asyncio
async def test_sale_ping_off_allowlist_product_persists_sale_without_granting(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
) -> None:
    """A sale for a non-APTITUDE product stores the sale but grants no access.

    A pre-registered user whose email matches must not receive course_access
    from a product that is not on ``GUMROAD_APTITUDE_PRODUCT_IDS`` (e.g. a
    future token-pack product on the same Gumroad account); the verbatim sale
    row is still captured.
    """
    _user, _user_id = await _persist_user(db_session)

    response = await async_client.post(
        WEBHOOK_PATH,
        params={"secret": webhook_secret},
        data=_sale_payload(product_id=OFF_ALLOWLIST_PRODUCT_ID),
    )

    assert response.status_code == HTTPStatus.OK
    assert await _count_sales(db_session) == 1
    assert await _count_entitlements(db_session) == 0


@pytest.mark.asyncio
async def test_non_sale_event_does_not_grant_entitlement(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
) -> None:
    """A non-sale resource_name is persisted but never dispatches a grant."""
    _user, _user_id = await _persist_user(db_session)

    response = await async_client.post(
        WEBHOOK_PATH,
        params={"secret": webhook_secret},
        data=_sale_payload(resource_name=NON_SALE_RESOURCE),
    )

    assert response.status_code == HTTPStatus.OK
    assert await _count_sales(db_session) == 1
    assert await _count_entitlements(db_session) == 0


@pytest.mark.asyncio
async def test_webhook_first_then_signup_links_entitlement_to_stored_sale(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A sale that arrives before signup is linked once the buyer redeems a license."""
    ping = await async_client.post(
        WEBHOOK_PATH, params={"secret": webhook_secret}, data=_sale_payload()
    )
    assert ping.status_code == HTTPStatus.OK
    sale_row = (await db_session.execute(select(GumroadSale))).scalar_one()
    assert await _count_entitlements(db_session) == 0

    monkeypatch.setenv(PRODUCT_IDS_ENV, PRODUCT_ID)
    monkeypatch.setattr(VERIFY_SEAM, _make_success_stub())

    signup = await async_client.post(
        SIGNUP_PATH,
        json={
            "email": BUYER_EMAIL,
            "password": SIGNUP_PASSWORD,
            "license_key": LICENSE_KEY,
        },
    )

    assert signup.status_code == HTTPStatus.OK
    entitlement = (await db_session.execute(select(Entitlement))).scalar_one()
    assert entitlement.source_sale_id == sale_row.id
    assert entitlement.user_id == signup.json()["user_id"]
    assert entitlement.kind == COURSE_ACCESS_KIND
    assert entitlement.revoked_at is None
    binding = (await db_session.execute(select(LicenseBinding))).scalar_one()
    assert binding.user_id == signup.json()["user_id"]
    assert binding.gumroad_sale_id == SALE_ID


@pytest.mark.asyncio
async def test_a_sale_bound_by_a_gift_recipient_never_grants_the_buyers_account(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Once the recipient has redeemed the key, the buyer-email ping follows the binding.

    The buyer has an account and no access — exactly the shape the email
    auto-claim exists for — yet the sale is already bound elsewhere, so the
    ping (and its replay) grants the recipient, not the buyer.
    """
    _buyer, buyer_id = await _persist_user(db_session)
    monkeypatch.setattr(VERIFY_SEAM, _make_success_stub())
    recipient_id = await _signup_with_license(async_client, RECIPIENT_EMAIL)

    first = await async_client.post(
        WEBHOOK_PATH, params={"secret": webhook_secret}, data=_sale_payload()
    )
    replay = await async_client.post(
        WEBHOOK_PATH, params={"secret": webhook_secret}, data=_sale_payload()
    )

    assert [first.status_code, replay.status_code] == [HTTPStatus.OK, HTTPStatus.OK]
    assert await _active_entitlements_of(db_session, buyer_id) == 0
    assert await _active_entitlements_of(db_session, recipient_id) == 1
    assert await _count_entitlements(db_session) == 1
    bindings = await _bindings(db_session)
    assert [(row.user_id, row.gumroad_sale_id) for row in bindings] == [(recipient_id, SALE_ID)]


@pytest.mark.asyncio
async def test_a_second_sale_for_a_buyer_who_already_has_access_is_left_unclaimed(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A member buying again is buying a gift: the sale waits for whoever holds the key."""
    caplog.set_level(logging.DEBUG)
    _buyer, buyer_id = await _persist_user(db_session)
    await async_client.post(WEBHOOK_PATH, params={"secret": webhook_secret}, data=_sale_payload())
    assert await _active_entitlements_of(db_session, buyer_id) == 1

    gift = await async_client.post(
        WEBHOOK_PATH,
        params={"secret": webhook_secret},
        data=_sale_payload(sale_id=GIFT_SALE_ID),
    )

    assert gift.status_code == HTTPStatus.OK
    assert [row.gumroad_sale_id for row in await _bindings(db_session)] == [SALE_ID]
    assert await _count_entitlements(db_session) == 1
    assert _log_carries_marker(caplog, LEFT_UNCLAIMED_MARKER)

    monkeypatch.setattr(VERIFY_SEAM, _make_success_stub(sale_id=GIFT_SALE_ID))
    recipient_id = await _signup_with_license(async_client, RECIPIENT_EMAIL)

    assert await _active_entitlements_of(db_session, recipient_id) == 1
    assert sorted((row.user_id, row.gumroad_sale_id) for row in await _bindings(db_session)) == [
        (buyer_id, SALE_ID),
        (recipient_id, GIFT_SALE_ID),
    ]


# -- Token-pack credit branch ------------------------------------------------


@pytest.fixture
def token_pack_config(monkeypatch: pytest.MonkeyPatch) -> str:
    """Allowlist the token-pack products and size only the sellable one.

    ``UNSIZED_TOKEN_PACK_PRODUCT_ID`` is deliberately allowlisted without a
    size so the unconfigured-size branch has a product to exercise.
    """
    monkeypatch.setenv(
        TOKEN_PACK_PRODUCT_IDS_ENV_VAR,
        f"{TOKEN_PACK_PRODUCT_ID},{UNSIZED_TOKEN_PACK_PRODUCT_ID}",
    )
    monkeypatch.setenv(TOKEN_PACK_SIZES_ENV_VAR, f"{TOKEN_PACK_PRODUCT_ID}:{TOKEN_PACK_SIZE}")
    return TOKEN_PACK_PRODUCT_ID


def _token_pack_payload(**overrides: str) -> dict[str, str]:
    """Build a ping payload for a token-pack sale, with optional overrides."""
    pack_defaults = {"sale_id": TOKEN_PACK_SALE_ID, "product_id": TOKEN_PACK_PRODUCT_ID}
    return _sale_payload(**{**pack_defaults, **overrides})


async def _offering_balance(db_session: AsyncSession, user_id: int) -> int:
    """Return the user's persisted offering balance, read fresh."""
    result = await db_session.execute(
        select(User).where(User.id == user_id).execution_options(populate_existing=True)
    )
    return int(result.scalars().one().offering_balance)


async def _count_purchase_audits(db_session: AsyncSession) -> int:
    """Count only ``gumroad_purchase`` audit rows so other reasons cannot skew."""
    result = await db_session.execute(
        select(func.count())
        .select_from(WalletAudit)
        .where(WalletAudit.reason == REASON_GUMROAD_PURCHASE)
    )
    return int(result.scalar_one())


async def _reload_sale(db_session: AsyncSession, sale_id: str) -> GumroadSale:
    """Re-read one sale row from the database, bypassing the identity map."""
    result = await db_session.execute(
        select(GumroadSale)
        .where(GumroadSale.gumroad_sale_id == sale_id)
        .execution_options(populate_existing=True)
    )
    return result.scalars().one()


@pytest.mark.asyncio
@pytest.mark.usefixtures("token_pack_config")
async def test_token_pack_ping_credits_registered_buyer(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
) -> None:
    """A token-pack sale credits exactly the configured pack size and claims the sale."""
    _user, user_id = await _persist_user(db_session)

    response = await async_client.post(
        WEBHOOK_PATH,
        params={"secret": webhook_secret},
        data=_token_pack_payload(**{PAYLOAD_QUANTITY_FIELD: PAYLOAD_QUANTITY_VALUE}),
    )

    assert response.status_code == HTTPStatus.OK
    assert await _offering_balance(db_session, user_id) == TOKEN_PACK_SIZE
    assert await _count_purchase_audits(db_session) == 1
    sale = await _reload_sale(db_session, TOKEN_PACK_SALE_ID)
    assert sale.token_pack_credited_at is not None
    assert sale.token_pack_credited_user_id == user_id


@pytest.mark.asyncio
@pytest.mark.usefixtures("token_pack_config")
async def test_replayed_token_pack_ping_credits_once(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
) -> None:
    """A duplicate delivery of the same ping stays 200 and never double-credits."""
    _user, user_id = await _persist_user(db_session)
    payload = _token_pack_payload()

    first = await async_client.post(WEBHOOK_PATH, params={"secret": webhook_secret}, data=payload)
    second = await async_client.post(WEBHOOK_PATH, params={"secret": webhook_secret}, data=payload)

    assert first.status_code == HTTPStatus.OK
    assert second.status_code == HTTPStatus.OK
    assert await _count_sales(db_session) == 1
    assert await _offering_balance(db_session, user_id) == TOKEN_PACK_SIZE
    assert await _count_purchase_audits(db_session) == 1


@pytest.mark.asyncio
@pytest.mark.usefixtures("token_pack_config")
async def test_token_pack_ping_without_user_leaves_sale_unclaimed(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
) -> None:
    """With no account yet the sale is stored unclaimed, awaiting the signup sweep."""
    response = await async_client.post(
        WEBHOOK_PATH, params={"secret": webhook_secret}, data=_token_pack_payload()
    )

    assert response.status_code == HTTPStatus.OK
    assert await _count_sales(db_session) == 1
    sale = await _reload_sale(db_session, TOKEN_PACK_SALE_ID)
    assert sale.token_pack_credited_at is None
    assert sale.token_pack_credited_user_id is None
    assert await _count_purchase_audits(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("token_pack_config")
async def test_aptitude_sale_leaves_offering_balance_untouched(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
) -> None:
    """A course sale grants access without minting a single wallet credit."""
    _user, user_id = await _persist_user(db_session)

    response = await async_client.post(
        WEBHOOK_PATH, params={"secret": webhook_secret}, data=_sale_payload()
    )

    assert response.status_code == HTTPStatus.OK
    assert await _count_entitlements(db_session) == 1
    assert await _offering_balance(db_session, user_id) == 0
    assert await _count_purchase_audits(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("token_pack_config")
async def test_token_pack_sale_grants_no_entitlement(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
) -> None:
    """Buying credits must never hand out course access."""
    _user, user_id = await _persist_user(db_session)

    response = await async_client.post(
        WEBHOOK_PATH, params={"secret": webhook_secret}, data=_token_pack_payload()
    )

    assert response.status_code == HTTPStatus.OK
    assert await _offering_balance(db_session, user_id) == TOKEN_PACK_SIZE
    assert await _count_entitlements(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("token_pack_config")
async def test_refunded_token_pack_ping_credits_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A refunded sale is persisted for the record but never credited."""
    caplog.set_level(logging.DEBUG)
    _user, user_id = await _persist_user(db_session)

    response = await async_client.post(
        WEBHOOK_PATH,
        params={"secret": webhook_secret},
        data=_token_pack_payload(refunded="true"),
    )

    assert response.status_code == HTTPStatus.OK
    assert await _count_sales(db_session) == 1
    assert await _offering_balance(db_session, user_id) == 0
    assert await _count_purchase_audits(db_session) == 0
    assert _log_carries_marker(caplog, REFUNDED_SALE_MARKER)


@pytest.mark.asyncio
@pytest.mark.usefixtures("token_pack_config")
async def test_unsized_token_pack_product_credits_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An allowlisted pack with no configured size fails closed and says so."""
    caplog.set_level(logging.DEBUG)
    _user, user_id = await _persist_user(db_session)

    response = await async_client.post(
        WEBHOOK_PATH,
        params={"secret": webhook_secret},
        data=_token_pack_payload(product_id=UNSIZED_TOKEN_PACK_PRODUCT_ID),
    )

    assert response.status_code == HTTPStatus.OK
    assert await _offering_balance(db_session, user_id) == 0
    assert await _count_purchase_audits(db_session) == 0
    assert _log_carries_marker(caplog, UNCONFIGURED_SIZE_MARKER)


@pytest.mark.asyncio
@pytest.mark.usefixtures("token_pack_config")
async def test_product_on_neither_allowlist_is_logged_and_inert(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An unrecognised product grants nothing, credits nothing, and is flagged."""
    caplog.set_level(logging.DEBUG)
    _user, user_id = await _persist_user(db_session)

    response = await async_client.post(
        WEBHOOK_PATH,
        params={"secret": webhook_secret},
        data=_token_pack_payload(product_id=UNKNOWN_PRODUCT_ID),
    )

    assert response.status_code == HTTPStatus.OK
    assert await _offering_balance(db_session, user_id) == 0
    assert await _count_purchase_audits(db_session) == 0
    assert await _count_entitlements(db_session) == 0
    assert _log_carries_marker(caplog, UNKNOWN_PRODUCT_MARKER)


@pytest.mark.asyncio
@pytest.mark.usefixtures("token_pack_config")
async def test_non_sale_resource_with_token_pack_product_credits_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
) -> None:
    """A refund event carrying a pack product must not credit the wallet."""
    _user, user_id = await _persist_user(db_session)

    response = await async_client.post(
        WEBHOOK_PATH,
        params={"secret": webhook_secret},
        data=_token_pack_payload(resource_name=NON_SALE_RESOURCE),
    )

    assert response.status_code == HTTPStatus.OK
    assert await _count_sales(db_session) == 1
    assert await _offering_balance(db_session, user_id) == 0
    assert await _count_purchase_audits(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("token_pack_config")
async def test_token_pack_email_match_is_case_insensitive(
    async_client: AsyncClient,
    db_session: AsyncSession,
    webhook_secret: str,
) -> None:
    """A mixed-case buyer email still credits the lowercase stored account."""
    _user, user_id = await _persist_user(db_session)

    response = await async_client.post(
        WEBHOOK_PATH,
        params={"secret": webhook_secret},
        data=_token_pack_payload(email=MIXED_CASE_BUYER_EMAIL),
    )

    assert response.status_code == HTTPStatus.OK
    assert await _offering_balance(db_session, user_id) == TOKEN_PACK_SIZE
    assert await _count_purchase_audits(db_session) == 1


@pytest.mark.asyncio
@pytest.mark.usefixtures("token_pack_config", "webhook_secret")
async def test_forged_token_pack_ping_writes_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A ping with the wrong shared secret mints no credits and stores no rows."""
    _user, user_id = await _persist_user(db_session)

    response = await async_client.post(
        WEBHOOK_PATH,
        params={"secret": WRONG_WEBHOOK_SECRET},
        data=_token_pack_payload(),
    )

    assert response.status_code == HTTPStatus.UNAUTHORIZED
    assert await _count_sales(db_session) == 0
    assert await _count_purchase_audits(db_session) == 0
    assert await _offering_balance(db_session, user_id) == 0
