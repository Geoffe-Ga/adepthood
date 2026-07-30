"""License-gated signup tests for POST /auth/signup.

Contract: signup requires a license_key; every rejection path returns the
same generic detail (license_required for a missing key, invalid_license for
everything else) without creating User or Entitlement rows or leaking that
an account exists; the verifier is consulted only for products on the
GUMROAD_APTITUDE_PRODUCT_IDS allowlist and stops on the first success; a
Gumroad outage fails closed with 503; more than ten invalid-license attempts
per client per hour are throttled with 429 and cost Gumroad nothing, because
the cap is consulted before any outbound verify; every failure path still
spends a dummy bcrypt verify for timing parity.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
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
from rate_limit import INVALID_LICENSE_MAX_PER_HOUR
from schemas.gumroad import GumroadLicenseResult, GumroadPurchase

pytestmark = pytest.mark.real_license_gate

SIGNUP_PATH = "/auth/signup"
PRODUCT_IDS_ENV = "GUMROAD_APTITUDE_PRODUCT_IDS"
API_TOKEN_ENV = "GUMROAD_API_TOKEN"
WEBHOOK_SECRET_ENV = "GUMROAD_WEBHOOK_SECRET"  # pragma: allowlist secret
GUMROAD_CREDENTIAL_ENV_VARS = (API_TOKEN_ENV, WEBHOOK_SECRET_ENV)
VERIFY_SEAM = "domain.entitlements.verify_license"
REJECT_DUPLICATE_SEAM = "routers.auth._reject_duplicate_signup_email"
CAP_PEEK_SEAM = "routers.auth.invalid_license_cap_exhausted"
ALLOWED_PRODUCT_ALPHA = "prod_alpha"
ALLOWED_PRODUCT_BETA = "prod_beta"
ALLOWLIST = f"{ALLOWED_PRODUCT_ALPHA},{ALLOWED_PRODUCT_BETA}"
# One outbound verify per allowlisted product is spent on every unmatched key.
ALLOWLIST_PRODUCT_COUNT = len(ALLOWLIST.split(","))
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
INVALID_ATTEMPT_EMAIL_PREFIX = "attempt-"
FINAL_ATTEMPT_EMAIL = "attempt-final@example.com"
BLANK_LICENSE_KEY = ""
WHITESPACE_LICENSE_KEY = "   "
TRUSTED_PROXY_CIDRS_ENV = "TRUSTED_PROXY_CIDRS"
# Documentation-range prefix (RFC 5737) for the spoofed forwarded addresses.
SPOOFED_IP_PREFIX = "203.0.113."
# One character past the schema's license_key ceiling; must be rejected by
# Pydantic before any outbound Gumroad verify runs.
OVER_LENGTH_LICENSE_KEY = "A" * 129

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


@dataclass(frozen=True)
class _Reversal:
    """The four documented Gumroad reversal-state flags for a purchase fixture."""

    refunded: bool = False
    chargebacked: bool = False
    disputed: bool = False
    dispute_won: bool = False


_NO_REVERSAL = _Reversal()


def _license_result(
    email: str = SIGNUP_EMAIL,
    product_id: str = ALLOWED_PRODUCT_ALPHA,
    *,
    success: bool = True,
    reversal: _Reversal = _NO_REVERSAL,
) -> GumroadLicenseResult:
    """Build a Gumroad verify result for the given purchase identity."""
    return GumroadLicenseResult(
        success=success,
        uses=LICENSE_USES,
        purchase=GumroadPurchase(
            email=email,
            product_id=product_id,
            sale_id=SALE_ID,
            refunded=reversal.refunded,
            chargebacked=reversal.chargebacked,
            disputed=reversal.disputed,
            dispute_won=reversal.dispute_won,
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
    results = {ALLOWED_PRODUCT_ALPHA: _license_result(reversal=_Reversal(refunded=True))}
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
    results = {
        ALLOWED_PRODUCT_ALPHA: _license_result(reversal=_Reversal(chargebacked=True)),
    }
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub(results, calls))

    response = await async_client.post(SIGNUP_PATH, json=_signup_payload())

    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert response.json()["detail"] == DETAIL_INVALID_LICENSE
    assert await _count_users(db_session) == 0
    assert await _count_entitlements(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products")
async def test_disputed_unresolved_license_is_invalid_license_and_writes_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A purchase under an unresolved chargeback dispute is rejected, no rows written."""
    calls: list[tuple[str, str]] = []
    results = {ALLOWED_PRODUCT_ALPHA: _license_result(reversal=_Reversal(disputed=True))}
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub(results, calls))

    response = await async_client.post(SIGNUP_PATH, json=_signup_payload())

    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert response.json()["detail"] == DETAIL_INVALID_LICENSE
    assert await _count_users(db_session) == 0
    assert await _count_entitlements(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products")
async def test_dispute_won_license_is_accepted_and_creates_user(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A dispute the seller won leaves the sale legitimate: signup still succeeds."""
    calls: list[tuple[str, str]] = []
    results = {
        ALLOWED_PRODUCT_ALPHA: _license_result(
            reversal=_Reversal(disputed=True, dispute_won=True),
        ),
    }
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub(results, calls))

    response = await async_client.post(SIGNUP_PATH, json=_signup_payload())

    assert response.status_code == HTTPStatus.OK
    assert await _count_users(db_session) == 1
    assert await _count_entitlements(db_session) == 1


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
async def test_signup_with_unconfigured_allowlist_rejects_and_calls_no_verifier(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unset product allowlist grants nobody access and makes no outbound call.

    Deliberately skips the ``allowlisted_products`` fixture: this pins the
    fail-closed floor an unconfigured deployment relies on, where an empty
    API token would otherwise be spent on a doomed Gumroad request.
    """
    monkeypatch.delenv(PRODUCT_IDS_ENV, raising=False)
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub({}, calls))

    response = await async_client.post(SIGNUP_PATH, json=_signup_payload())

    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert response.json()["detail"] == DETAIL_INVALID_LICENSE
    assert calls == []
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
@pytest.mark.usefixtures("allowlisted_products", "disable_rate_limit")
async def test_race_duplicate_matches_precheck_rejection_shape(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The IntegrityError race fallback returns the identical 400 shape as the pre-check.

    A duplicate email caught by the concurrent-insert race must be
    indistinguishable from one caught by the up-front existence check: same
    status, same JSON body, no token. Silencing the pre-check forces the
    insert to reach the unique index and raise ``IntegrityError``, so the
    fallback branch runs — and its response must match the pre-check's byte
    for byte, or an observer could tell which path fired.
    """
    calls: list[tuple[str, str]] = []
    results = {ALLOWED_PRODUCT_ALPHA: _license_result()}
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub(results, calls))

    first = await async_client.post(SIGNUP_PATH, json=_signup_payload())
    assert first.status_code == HTTPStatus.OK

    # Pre-check path: the second signup finds the existing row up front.
    precheck = await async_client.post(SIGNUP_PATH, json=_signup_payload())
    assert precheck.status_code == HTTPStatus.BAD_REQUEST
    assert precheck.json()["detail"] == DETAIL_INVALID_LICENSE

    # Race path: silence the pre-check so the insert reaches the unique
    # index and raises IntegrityError, exercising the fallback branch.
    monkeypatch.setattr(REJECT_DUPLICATE_SEAM, AsyncMock(return_value=None))
    race = await async_client.post(SIGNUP_PATH, json=_signup_payload())

    assert race.status_code == precheck.status_code
    assert race.json() == precheck.json()
    assert "token" not in race.json()
    assert await _count_users(db_session) == 1
    assert await _count_entitlements(db_session) == 1


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
@pytest.mark.usefixtures("allowlisted_products")
async def test_signup_with_unset_api_token_fails_closed_with_503(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A credentialless production deploy with a populated allowlist fails closed.

    The startup check lets production boot with neither Gumroad credential
    set, so this state is now reachable at request time. Verification is
    still attempted for each allowlisted product, the blank token makes
    Gumroad answer non-2xx, and the resulting unavailability is a 503 with
    no account and no entitlement written.
    """
    for name in GUMROAD_CREDENTIAL_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub({}, calls, unavailable=True))

    response = await async_client.post(SIGNUP_PATH, json=_signup_payload())

    assert response.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert response.json()["detail"] == DETAIL_UNAVAILABLE
    assert calls == [(ALLOWED_PRODUCT_ALPHA, LICENSE_KEY)]
    assert await _count_users(db_session) == 0
    assert await _count_entitlements(db_session) == 0


async def _exhaust_invalid_license_cap(async_client: AsyncClient) -> None:
    """Spend the client's whole hourly budget on rejected invalid-license signups.

    Each attempt uses a distinct email so nothing is refused as a duplicate:
    every one of them has to land on the invalid-license path and charge the
    cap. Requires an already-patched verifier that matches no product.
    """
    for attempt in range(INVALID_LICENSE_MAX_PER_HOUR):
        response = await async_client.post(
            SIGNUP_PATH,
            json=_signup_payload(email=f"{INVALID_ATTEMPT_EMAIL_PREFIX}{attempt}@example.com"),
        )
        assert response.status_code == HTTPStatus.BAD_REQUEST
        assert response.json()["detail"] == DETAIL_INVALID_LICENSE


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products", "disable_rate_limit")
async def test_eleventh_invalid_license_attempt_is_throttled(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """After ten invalid-license attempts in the hour, the next one returns 429."""
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub({}, calls))

    await _exhaust_invalid_license_cap(async_client)

    throttled = await async_client.post(
        SIGNUP_PATH,
        json=_signup_payload(email=FINAL_ATTEMPT_EMAIL),
    )

    assert throttled.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert throttled.json()["detail"] == DETAIL_THROTTLED


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products", "disable_rate_limit")
async def test_capped_client_causes_no_outbound_gumroad_call(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A client whose hourly budget is spent drives zero further Gumroad calls.

    The cap exists to stop a client grinding license keys through Gumroad, so
    it has to be consulted before the per-product verify loop runs. Once the
    budget is gone the refusal must cost Gumroad nothing: no allowlisted
    product is queried, so the recorded call list cannot grow.
    """
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub({}, calls))

    await _exhaust_invalid_license_cap(async_client)
    calls_while_uncapped = len(calls)
    assert calls_while_uncapped == INVALID_LICENSE_MAX_PER_HOUR * ALLOWLIST_PRODUCT_COUNT

    throttled = await async_client.post(
        SIGNUP_PATH,
        json=_signup_payload(email=FINAL_ATTEMPT_EMAIL),
    )

    assert throttled.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert throttled.json()["detail"] == DETAIL_THROTTLED
    assert len(calls) == calls_while_uncapped


def _peek_reports_budget_remaining(_key: str) -> bool:
    """Stand in for the non-consuming peek answering that budget is left."""
    return False


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products", "disable_rate_limit")
async def test_racing_past_the_peek_is_still_refused_by_the_charge(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The consuming charge answers 429 on its own once the peek has been cleared.

    The front gate only peeks, so it cannot serialise anything: with the
    budget one unit short, two concurrent requests can both read "not
    exhausted" and both walk on to the verify. Whichever of them then loses
    the consuming charge has to answer 429 rather than fall through to the
    ordinary invalid_license, or the cap leaks one extra refusal shape per
    race. A sequential test cannot produce that interleaving, so the peek is
    replaced with one that reports budget remaining while the charge stays
    real -- exactly the state the losing racer observes.
    """
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub({}, calls))
    await _exhaust_invalid_license_cap(async_client)
    calls_while_uncapped = len(calls)

    monkeypatch.setattr(CAP_PEEK_SEAM, _peek_reports_budget_remaining)
    throttled = await async_client.post(
        SIGNUP_PATH,
        json=_signup_payload(email=FINAL_ATTEMPT_EMAIL),
    )

    assert throttled.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert throttled.json()["detail"] == DETAIL_THROTTLED
    # The verify loop ran, so the refusal came from the charge, not the peek.
    assert len(calls) == calls_while_uncapped + ALLOWLIST_PRODUCT_COUNT
    assert await _count_users(db_session) == 0
    assert await _count_entitlements(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products", "disable_rate_limit")
async def test_capped_client_with_valid_license_is_refused_without_gumroad_call(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A capped client is refused even holding a key that would have verified.

    This is the deliberate cost of refusing before the call: whether the key
    is genuine is unknowable without the very Gumroad request the cap forbids,
    so the throttle wins and the legitimate buyer waits out the hour. The
    refusal is the same 429, no outbound call is made, and no account or
    entitlement is created off an unverified key.
    """
    failing_calls: list[tuple[str, str]] = []
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub({}, failing_calls))
    await _exhaust_invalid_license_cap(async_client)

    granting_calls: list[tuple[str, str]] = []
    granting_results = {ALLOWED_PRODUCT_ALPHA: _license_result()}
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub(granting_results, granting_calls))

    throttled = await async_client.post(SIGNUP_PATH, json=_signup_payload())

    assert throttled.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert throttled.json()["detail"] == DETAIL_THROTTLED
    assert granting_calls == []
    assert await _count_users(db_session) == 0
    assert await _count_entitlements(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products", "disable_rate_limit")
@pytest.mark.parametrize(
    "blank_license_key",
    [BLANK_LICENSE_KEY, WHITESPACE_LICENSE_KEY],
    ids=["empty", "whitespace-only"],
)
async def test_capped_client_with_blank_license_key_still_gets_license_required(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    blank_license_key: str,
) -> None:
    """A blank key answers license_required even from a capped client, never 429.

    A blank key short-circuits inside the license gate before any Gumroad
    request, so it is not a guess and there is no egress for the cap to
    protect. Refusing it with the throttle instead would both mislabel a
    malformed request and let an attacker learn where the cap stands.

    A whitespace-only key is blank by the same measure the gate uses, so it
    is pinned alongside the empty one: dropping the strip would turn it into
    a throttled guess that also spends outbound Gumroad calls.
    """
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub({}, calls))
    await _exhaust_invalid_license_cap(async_client)
    calls_while_uncapped = len(calls)

    response = await async_client.post(
        SIGNUP_PATH,
        json=_signup_payload(email=FINAL_ATTEMPT_EMAIL, license_key=blank_license_key),
    )

    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert response.json()["detail"] == DETAIL_LICENSE_REQUIRED
    assert len(calls) == calls_while_uncapped
    assert await _count_users(db_session) == 0
    assert await _count_entitlements(db_session) == 0


def _spoofed_forwarded_ip(attempt: int) -> str:
    """Build a distinct forged X-Forwarded-For value for ``attempt``."""
    return f"{SPOOFED_IP_PREFIX}{attempt + 1}"


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products", "disable_rate_limit")
async def test_rotating_x_forwarded_for_cannot_reset_the_invalid_license_cap(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A fresh forged X-Forwarded-For per attempt does not mint a fresh hourly bucket.

    With no trusted proxy configured the header carries no authority, so every
    attempt keys on the socket peer and the cap still trips on the next one.
    """
    monkeypatch.delenv(TRUSTED_PROXY_CIDRS_ENV, raising=False)
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub({}, calls))

    for attempt in range(INVALID_LICENSE_MAX_PER_HOUR):
        response = await async_client.post(
            SIGNUP_PATH,
            json=_signup_payload(email=f"spoofed-{attempt}@example.com"),
            headers={"X-Forwarded-For": _spoofed_forwarded_ip(attempt)},
        )
        assert response.status_code == HTTPStatus.BAD_REQUEST
        assert response.json()["detail"] == DETAIL_INVALID_LICENSE

    throttled = await async_client.post(
        SIGNUP_PATH,
        json=_signup_payload(email="spoofed-final@example.com"),
        headers={"X-Forwarded-For": _spoofed_forwarded_ip(INVALID_LICENSE_MAX_PER_HOUR)},
    )

    assert throttled.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert throttled.json()["detail"] == DETAIL_THROTTLED


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products")
async def test_over_length_license_key_is_rejected_before_any_gumroad_call(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An over-length license_key is a 422 schema rejection, no verify runs.

    The unbounded string never reaches the per-product outbound verify loop,
    so the mocked verifier must never be invoked and no rows are written. The
    rejection is a schema-shape one (same as an over-length password), so no
    timing-parity obligation applies and nothing leaks about key validity.
    """
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub({}, calls))

    response = await async_client.post(
        SIGNUP_PATH,
        json=_signup_payload(license_key=OVER_LENGTH_LICENSE_KEY),
    )

    assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert calls == []
    assert await _count_users(db_session) == 0
    assert await _count_entitlements(db_session) == 0


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


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products", "disable_rate_limit")
async def test_throttled_license_path_consumes_a_dummy_bcrypt_verify(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The over-cap 429 spends the same dummy bcrypt every other rejection spends.

    Refusing before the outbound call makes the throttled path cheaper than the
    uncapped one, so the CPU cost has to stay: without it the 429 would answer
    measurably faster and hand an attacker a timing oracle for the cap state.
    The spy stands in for the real hash, so it is installed before the budget
    is spent and its count is compared across the final request only.
    """
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub({}, calls))
    password_verify_spy = AsyncMock(return_value=None)
    monkeypatch.setattr("routers.auth._consume_dummy_password_verify", password_verify_spy)

    await _exhaust_invalid_license_cap(async_client)
    awaits_while_uncapped = password_verify_spy.await_count

    throttled = await async_client.post(
        SIGNUP_PATH,
        json=_signup_payload(email=FINAL_ATTEMPT_EMAIL),
    )

    assert throttled.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert throttled.json()["detail"] == DETAIL_THROTTLED
    assert password_verify_spy.await_count == awaits_while_uncapped + 1
