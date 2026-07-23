"""License-gated signup tests for POST /auth/signup.

Contract: signup requires a license_key; every rejection path returns the
same generic detail (license_required for a missing key, invalid_license for
everything else) without creating User or Entitlement rows or leaking that
an account exists; the verifier is consulted only for products on the
GUMROAD_APTITUDE_PRODUCT_IDS allowlist and stops on the first success; a
Gumroad outage fails closed with 503; more than ten invalid-license attempts
per client per hour are throttled with 429; every failure path still spends
a dummy bcrypt verify for timing parity.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Mapping
from http import HTTPStatus
from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from integrations.gumroad import GumroadUnavailableError
from models.entitlement import Entitlement
from models.user import User
from schemas.gumroad import GumroadLicenseResult, GumroadPurchase

pytestmark = pytest.mark.real_license_gate

SIGNUP_PATH = "/auth/signup"
PRODUCT_IDS_ENV = "GUMROAD_APTITUDE_PRODUCT_IDS"
VERIFY_SEAM = "domain.entitlements.verify_license"
ALLOWED_PRODUCT_ALPHA = "prod_alpha"
ALLOWED_PRODUCT_BETA = "prod_beta"
ALLOWLIST = f"{ALLOWED_PRODUCT_ALPHA},{ALLOWED_PRODUCT_BETA}"
UNLISTED_PRODUCT = "prod_unlisted"
SIGNUP_EMAIL = "seeker@example.com"
MIXED_CASE_LICENSE_EMAIL = "Seeker@Example.COM"
OTHER_EMAIL = "someone-else@example.com"
SIGNUP_PASSWORD = "securepassword123"  # pragma: allowlist secret
LICENSE_KEY = "ABCD1234-EF56-7890-TEST"  # pragma: allowlist secret
SALE_ID = "S-900"
COURSE_ACCESS_KIND = "course_access"
LICENSE_USES = 1
JWT_SEGMENT_COUNT = 3
INVALID_LICENSE_ATTEMPT_CAP = 10

DETAIL_LICENSE_REQUIRED = "license_required"
DETAIL_INVALID_LICENSE = "invalid_license"
DETAIL_UNAVAILABLE = "license_verification_unavailable"
DETAIL_THROTTLED = "too_many_license_attempts"
EMAIL_MISMATCH_MARKER = "email_mismatch"
DUPLICATE_SIGNUP_MARKER = "duplicate_signup"
GUMROAD_DOWN_MESSAGE = "gumroad unavailable in test"

VerifyStub = Callable[..., Awaitable[GumroadLicenseResult | None]]


@pytest.fixture
def allowlisted_products(monkeypatch: pytest.MonkeyPatch) -> str:
    """Point the APTITUDE product allowlist at the two test product ids."""
    monkeypatch.setenv(PRODUCT_IDS_ENV, ALLOWLIST)
    return ALLOWLIST


def _log_carries_marker(caplog: pytest.LogCaptureFixture, marker: str) -> bool:
    """Return True when ``marker`` appears in captured text or as a reason_code."""
    if marker in caplog.text:
        return True
    return any(getattr(record, "reason_code", None) == marker for record in caplog.records)


def _license_result(
    email: str = SIGNUP_EMAIL,
    product_id: str = ALLOWED_PRODUCT_ALPHA,
    *,
    success: bool = True,
    refunded: bool = False,
    chargebacked: bool = False,
) -> GumroadLicenseResult:
    """Build a Gumroad verify result for the given purchase identity."""
    return GumroadLicenseResult(
        success=success,
        uses=LICENSE_USES,
        purchase=GumroadPurchase(
            email=email,
            product_id=product_id,
            sale_id=SALE_ID,
            refunded=refunded,
            chargebacked=chargebacked,
        ),
    )


def _make_verify_stub(
    results: Mapping[str, GumroadLicenseResult | None],
    calls: list[tuple[str, str]],
    *,
    unavailable: bool = False,
) -> VerifyStub:
    """Build a network-free verify_license stand-in that records its calls."""

    async def _verify(
        product_id: str,
        license_key: str,
        **_kwargs: object,
    ) -> GumroadLicenseResult | None:
        calls.append((product_id, license_key))
        if unavailable:
            raise GumroadUnavailableError(GUMROAD_DOWN_MESSAGE)
        return results.get(product_id)

    return _verify


def _signup_payload(
    email: str = SIGNUP_EMAIL,
    license_key: str | None = LICENSE_KEY,
) -> dict[str, str]:
    """Build a signup JSON body; ``license_key=None`` omits the field entirely."""
    payload = {"email": email, "password": SIGNUP_PASSWORD}
    if license_key is not None:
        payload["license_key"] = license_key
    return payload


async def _count_users(db_session: AsyncSession) -> int:
    """Return the number of User rows in the test database."""
    result = await db_session.execute(select(func.count()).select_from(User))
    return int(result.scalar_one())


async def _count_entitlements(db_session: AsyncSession) -> int:
    """Return the number of Entitlement rows in the test database."""
    result = await db_session.execute(select(func.count()).select_from(Entitlement))
    return int(result.scalar_one())


@pytest.mark.asyncio
@pytest.mark.parametrize("license_key", [None, ""])
async def test_signup_without_license_key_returns_license_required(
    async_client: AsyncClient,
    db_session: AsyncSession,
    license_key: str | None,
) -> None:
    """A missing or empty license_key is rejected with 400 license_required."""
    response = await async_client.post(SIGNUP_PATH, json=_signup_payload(license_key=license_key))

    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert response.json()["detail"] == DETAIL_LICENSE_REQUIRED
    assert await _count_users(db_session) == 0
    assert await _count_entitlements(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products")
async def test_unmatched_license_returns_invalid_license_and_writes_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When no allowlisted product verifies the key, signup is 400 with zero rows."""
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub({}, calls))

    response = await async_client.post(SIGNUP_PATH, json=_signup_payload())

    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert response.json()["detail"] == DETAIL_INVALID_LICENSE
    assert [product for product, _ in calls] == [ALLOWED_PRODUCT_ALPHA, ALLOWED_PRODUCT_BETA]
    assert all(key == LICENSE_KEY for _, key in calls)
    assert await _count_users(db_session) == 0
    assert await _count_entitlements(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products")
async def test_success_false_result_is_invalid_license(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A verify answer with success=False counts as no match, not as a grant."""
    calls: list[tuple[str, str]] = []
    results = {ALLOWED_PRODUCT_ALPHA: _license_result(success=False)}
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub(results, calls))

    response = await async_client.post(SIGNUP_PATH, json=_signup_payload())

    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert response.json()["detail"] == DETAIL_INVALID_LICENSE
    assert await _count_users(db_session) == 0
    assert await _count_entitlements(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products")
async def test_refunded_license_is_invalid_license_and_writes_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A refunded purchase is rejected exactly like an invalid key, no rows written."""
    caplog.set_level(logging.DEBUG)
    calls: list[tuple[str, str]] = []
    results = {ALLOWED_PRODUCT_ALPHA: _license_result(refunded=True)}
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub(results, calls))

    response = await async_client.post(SIGNUP_PATH, json=_signup_payload())

    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert response.json()["detail"] == DETAIL_INVALID_LICENSE
    assert await _count_users(db_session) == 0
    assert await _count_entitlements(db_session) == 0
    # The email matches the purchase, so a refund must not leak via the
    # email-mismatch marker: the rejection is indistinguishable from a bad key.
    assert not _log_carries_marker(caplog, EMAIL_MISMATCH_MARKER)


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products")
async def test_chargebacked_license_is_invalid_license_and_writes_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A charged-back purchase is rejected like an invalid key, no rows written."""
    calls: list[tuple[str, str]] = []
    results = {ALLOWED_PRODUCT_ALPHA: _license_result(chargebacked=True)}
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub(results, calls))

    response = await async_client.post(SIGNUP_PATH, json=_signup_payload())

    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert response.json()["detail"] == DETAIL_INVALID_LICENSE
    assert await _count_users(db_session) == 0
    assert await _count_entitlements(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products")
async def test_products_off_the_allowlist_are_never_verified(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A key valid only for a non-allowlisted product yields invalid_license."""
    calls: list[tuple[str, str]] = []
    results = {UNLISTED_PRODUCT: _license_result(product_id=UNLISTED_PRODUCT)}
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub(results, calls))

    response = await async_client.post(SIGNUP_PATH, json=_signup_payload())

    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert response.json()["detail"] == DETAIL_INVALID_LICENSE
    called_products = {product for product, _ in calls}
    assert UNLISTED_PRODUCT not in called_products
    assert called_products == {ALLOWED_PRODUCT_ALPHA, ALLOWED_PRODUCT_BETA}
    assert await _count_users(db_session) == 0
    assert await _count_entitlements(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products")
async def test_verification_stops_on_the_first_matching_product(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A match on the first allowlisted product short-circuits the loop."""
    calls: list[tuple[str, str]] = []
    results = {ALLOWED_PRODUCT_ALPHA: _license_result()}
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub(results, calls))

    response = await async_client.post(SIGNUP_PATH, json=_signup_payload())

    assert response.status_code == HTTPStatus.OK
    assert [product for product, _ in calls] == [ALLOWED_PRODUCT_ALPHA]


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products")
async def test_license_email_mismatch_is_invalid_license_and_logged(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A valid key issued to another email is rejected generically but logged."""
    caplog.set_level(logging.DEBUG)
    calls: list[tuple[str, str]] = []
    results = {ALLOWED_PRODUCT_ALPHA: _license_result(email=OTHER_EMAIL)}
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub(results, calls))

    response = await async_client.post(SIGNUP_PATH, json=_signup_payload())

    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert response.json()["detail"] == DETAIL_INVALID_LICENSE
    assert _log_carries_marker(caplog, EMAIL_MISMATCH_MARKER)
    assert await _count_users(db_session) == 0
    assert await _count_entitlements(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products")
async def test_license_email_match_is_case_insensitive(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A license issued to a mixed-case spelling of the signup email still matches."""
    calls: list[tuple[str, str]] = []
    results = {ALLOWED_PRODUCT_ALPHA: _license_result(email=MIXED_CASE_LICENSE_EMAIL)}
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub(results, calls))

    response = await async_client.post(SIGNUP_PATH, json=_signup_payload())

    assert response.status_code == HTTPStatus.OK
    assert await _count_users(db_session) == 1
    assert await _count_entitlements(db_session) == 1


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products")
async def test_successful_signup_creates_user_entitlement_and_jwt(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The happy path returns 200 with a JWT and persists one user + one entitlement."""
    calls: list[tuple[str, str]] = []
    results = {ALLOWED_PRODUCT_ALPHA: _license_result()}
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub(results, calls))

    response = await async_client.post(SIGNUP_PATH, json=_signup_payload())

    assert response.status_code == HTTPStatus.OK
    body = response.json()
    assert isinstance(body["token"], str)
    assert len(body["token"].split(".")) == JWT_SEGMENT_COUNT
    assert body["user_id"] > 0
    assert body["timezone"]

    users = (await db_session.execute(select(User))).scalars().all()
    assert len(users) == 1
    assert users[0].email == SIGNUP_EMAIL
    assert users[0].id == body["user_id"]

    entitlements = (await db_session.execute(select(Entitlement))).scalars().all()
    assert len(entitlements) == 1
    assert entitlements[0].kind == COURSE_ACCESS_KIND
    assert entitlements[0].user_id == body["user_id"]
    assert entitlements[0].revoked_at is None


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products")
async def test_duplicate_signup_is_invalid_license_without_leaking(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A second signup for the same email returns the generic 400, no token, no rows."""
    caplog.set_level(logging.DEBUG)
    calls: list[tuple[str, str]] = []
    results = {ALLOWED_PRODUCT_ALPHA: _license_result()}
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub(results, calls))

    first = await async_client.post(SIGNUP_PATH, json=_signup_payload())
    assert first.status_code == HTTPStatus.OK

    second = await async_client.post(SIGNUP_PATH, json=_signup_payload())

    assert second.status_code == HTTPStatus.BAD_REQUEST
    body = second.json()
    assert body["detail"] == DETAIL_INVALID_LICENSE
    assert "token" not in body
    assert await _count_users(db_session) == 1
    assert await _count_entitlements(db_session) == 1
    assert _log_carries_marker(caplog, DUPLICATE_SIGNUP_MARKER)


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products")
async def test_gumroad_outage_fails_closed_with_503(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GumroadUnavailableError maps to 503 and no account is created."""
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub({}, calls, unavailable=True))

    response = await async_client.post(SIGNUP_PATH, json=_signup_payload())

    assert response.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert response.json()["detail"] == DETAIL_UNAVAILABLE
    assert await _count_users(db_session) == 0
    assert await _count_entitlements(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products", "disable_rate_limit")
async def test_eleventh_invalid_license_attempt_is_throttled(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """After ten invalid-license attempts in the hour, the next one returns 429."""
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub({}, calls))

    for attempt in range(INVALID_LICENSE_ATTEMPT_CAP):
        response = await async_client.post(
            SIGNUP_PATH,
            json=_signup_payload(email=f"attempt-{attempt}@example.com"),
        )
        assert response.status_code == HTTPStatus.BAD_REQUEST
        assert response.json()["detail"] == DETAIL_INVALID_LICENSE

    throttled = await async_client.post(
        SIGNUP_PATH,
        json=_signup_payload(email="attempt-final@example.com"),
    )

    assert throttled.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert throttled.json()["detail"] == DETAIL_THROTTLED


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products")
async def test_invalid_license_path_consumes_a_dummy_bcrypt_verify(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The invalid-license rejection spends a dummy bcrypt for timing parity."""
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub({}, calls))
    password_verify_spy = AsyncMock(return_value=None)
    reset_token_spy = AsyncMock(return_value=None)
    monkeypatch.setattr("routers.auth._consume_dummy_password_verify", password_verify_spy)
    monkeypatch.setattr("routers.auth._consume_dummy_bcrypt", reset_token_spy)

    response = await async_client.post(SIGNUP_PATH, json=_signup_payload())

    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert response.json()["detail"] == DETAIL_INVALID_LICENSE
    assert password_verify_spy.await_count + reset_token_spy.await_count >= 1
