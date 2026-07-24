"""Sale-event dispatch tests for POST /webhooks/gumroad/ping.

Contract: an authenticated sale ping grants an idempotent active
course_access entitlement when a user with the buyer's email already exists
(matched case-insensitively) and links it to the persisted GumroadSale row;
with no matching user only the sale row is persisted; a later license-gated
signup for that email converges by linking its entitlement to the stored
sale; non-sale events never grant.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.entitlement import Entitlement
from models.gumroad_sale import GumroadSale
from models.user import User
from schemas.gumroad import GumroadLicenseResult, GumroadPurchase

pytestmark = pytest.mark.real_license_gate

WEBHOOK_PATH = "/webhooks/gumroad/ping"
WEBHOOK_SECRET = "gumroad-webhook-shared-secret-test-only"  # pragma: allowlist secret
SIGNUP_PATH = "/auth/signup"
PRODUCT_IDS_ENV = "GUMROAD_APTITUDE_PRODUCT_IDS"
VERIFY_SEAM = "domain.entitlements.verify_license"
BUYER_EMAIL = "buyer@example.com"
MIXED_CASE_BUYER_EMAIL = "Buyer@Example.COM"
SALE_ID = "S-100"
PRODUCT_ID = "prod_abc123"
OFF_ALLOWLIST_PRODUCT_ID = "prod_token_packs"
NON_SALE_RESOURCE = "refund"
LICENSE_KEY = "WEBHOOK-CONVERGENCE-TEST-KEY"  # pragma: allowlist secret
SIGNUP_PASSWORD = "securepassword123"  # pragma: allowlist secret
COURSE_ACCESS_KIND = "course_access"
LICENSE_USES = 1
WEBHOOK_SALE_MARKER = "webhook_sale"


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


def _make_success_stub() -> Callable[..., Awaitable[GumroadLicenseResult | None]]:
    """Build a verify_license stand-in that succeeds only for the webhook's sale."""

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
                sale_id=SALE_ID,
                refunded=False,
                chargebacked=False,
            ),
        )

    return _verify


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
