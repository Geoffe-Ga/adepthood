"""License-gated signup tests for POST /auth/signup.

Contract: signup requires a license_key; every rejection path returns the
same generic detail (license_required for a missing key, invalid_license for
everything else) without creating User, Entitlement or LicenseBinding rows or
leaking that an account exists; the verifier is consulted only for products on
the GUMROAD_APTITUDE_PRODUCT_IDS allowlist and stops on the first success; a
Gumroad outage fails closed with 503; more than ten invalid-license attempts
per client per hour are throttled with 429 and cost Gumroad nothing, because
the cap is consulted before any outbound verify; every failure path still
spends a dummy bcrypt verify for timing parity.

ADR 0008: possession of a live, allowlisted key is the whole claim proof — the
purchase email is never compared — and one sale binds to exactly one active
account. A key already bound to another account is refused with the very
bytes an unknown key gets, charges the same cap, and the raw key is never
persisted or logged.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from http import HTTPStatus
from unittest.mock import AsyncMock

import pytest
import sqlalchemy as sa
from httpx import AsyncClient, Response
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import SQLModel, select

from integrations.gumroad import GumroadUnavailableError
from models.entitlement import Entitlement
from models.license_binding import LicenseBinding
from models.user import User
from models.vault_activation import VaultActivation
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
THIRD_EMAIL = "third-party@example.com"
SIGNUP_PASSWORD = "securepassword123"  # pragma: allowlist secret
LICENSE_KEY = "ABCD1234-EF56-7890-TEST"  # pragma: allowlist secret
UNKNOWN_LICENSE_KEY = "UNKN0000-0000-0000-TEST"  # pragma: allowlist secret
REFUNDED_LICENSE_KEY = "RFND1111-1111-1111-TEST"  # pragma: allowlist secret
SALE_ID = "S-900"
RIVAL_SALE_ID = "S-901"
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
# Retired by ADR 0008: the purchase email is no longer compared, so no path may
# write this marker any more.
RETIRED_EMAIL_MISMATCH_MARKER = "email_mismatch"
ALREADY_BOUND_MARKER = "license_already_bound"
DUPLICATE_SIGNUP_MARKER = "duplicate_signup"
# Both pre-checks -- the router's post-verify one and the domain seam's own --
# read through this function; silencing it is what lets a test reach the
# UNIQUE constraint, the only defence that holds under a real race.
FIND_BINDING_SEAM = "domain.license_claims.find_binding"
CONCURRENT_RACERS = 2
RACER_STATUSES = sorted([HTTPStatus.OK, HTTPStatus.BAD_REQUEST])
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


def _make_keyed_verify_stub(
    results_by_key: Mapping[str, GumroadLicenseResult | None],
) -> VerifyStub:
    """Build a verify_license stand-in that answers per license key, alpha product only."""

    async def _verify(
        product_id: str,
        license_key: str,
        **_kwargs: object,
    ) -> GumroadLicenseResult | None:
        if product_id != ALLOWED_PRODUCT_ALPHA:
            return None
        return results_by_key.get(license_key)

    return _verify


def _fingerprint(response: Response) -> tuple[int, str | None, bytes]:
    """Return everything an unauthenticated observer can see about a rejection."""
    return (response.status_code, response.headers.get("content-type"), response.content)


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


async def _count_bindings(db_session: AsyncSession) -> int:
    """Return the number of LicenseBinding rows in the test database."""
    result = await db_session.execute(select(func.count()).select_from(LicenseBinding))
    return int(result.scalar_one())


async def _count_via(factory: async_sessionmaker[AsyncSession], model: type[SQLModel]) -> int:
    """Return the number of ``model`` rows in the concurrency fixture's database."""
    async with factory() as session:
        result = await session.execute(select(func.count()).select_from(model))
        return int(result.scalar_one())


def _holds_text(column: sa.Column[object]) -> bool:
    """Whether a column stores strings (SQLModel's AutoString hides its python type)."""
    if isinstance(column.type, sa.String):
        return True
    try:
        return column.type.python_type is str
    except NotImplementedError:
        return True


async def _rows_holding(db_session: AsyncSession, needle: str) -> dict[str, int]:
    """Row counts, per ``table.column``, whose text equals ``needle`` — anywhere at all."""
    counts: dict[str, int] = {}
    for table in SQLModel.metadata.sorted_tables:
        for column in table.columns:
            if not _holds_text(column):
                continue
            result = await db_session.execute(
                sa.select(sa.func.count()).select_from(table).where(column == needle)
            )
            counts[f"{table.name}.{column.name}"] = int(result.scalar_one())
    return counts


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
    # A refunded key is refused as unknown, never as "bound to someone": the
    # rejection is indistinguishable from a bad key in the log as well.
    assert not _log_carries_marker(caplog, ALREADY_BOUND_MARKER)


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
async def test_gifted_license_bought_under_another_email_creates_the_account(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A valid key bought under someone else's email still creates the account.

    ADR 0008 Decision 1: possession of a live, allowlisted key is the whole
    claim proof. The purchase email is financial data, not authorization data,
    so a gift recipient signing up under their own address is admitted and no
    ``email_mismatch`` marker is written anywhere.
    """
    caplog.set_level(logging.DEBUG)
    calls: list[tuple[str, str]] = []
    results = {ALLOWED_PRODUCT_ALPHA: _license_result(email=OTHER_EMAIL)}
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub(results, calls))

    response = await async_client.post(SIGNUP_PATH, json=_signup_payload())

    assert response.status_code == HTTPStatus.OK
    body = response.json()
    assert len(body["token"].split(".")) == JWT_SEGMENT_COUNT
    assert await _count_users(db_session) == 1
    entitlement = (await db_session.execute(select(Entitlement))).scalar_one()
    assert entitlement.revoked_at is None
    assert entitlement.user_id == body["user_id"]
    binding = (await db_session.execute(select(LicenseBinding))).scalar_one()
    assert binding.user_id == body["user_id"]
    assert binding.gumroad_sale_id == SALE_ID
    assert binding.product_id == ALLOWED_PRODUCT_ALPHA
    assert not _log_carries_marker(caplog, RETIRED_EMAIL_MISMATCH_MARKER)


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products")
async def test_purchase_email_case_is_irrelevant_to_the_claim(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The purchase address is not compared at all, so its spelling cannot matter."""
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
    assert (await db_session.execute(select(VaultActivation))).scalars().all() == []


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
@pytest.mark.usefixtures("allowlisted_products", "disable_rate_limit")
async def test_password_refusals_are_byte_identical_for_unknown_and_already_bound_keys(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An unknown key, a refunded key and a key bound to someone else look the same.

    ADR 0008 Decision 2: "valid but already claimed" must never be readable
    off the wire. Only the server log knows, as the WARNING carrying
    ``license_already_bound``.
    """
    caplog.set_level(logging.DEBUG)
    monkeypatch.setattr(
        VERIFY_SEAM,
        _make_keyed_verify_stub(
            {
                LICENSE_KEY: _license_result(email=OTHER_EMAIL),
                REFUNDED_LICENSE_KEY: _license_result(reversal=_Reversal(refunded=True)),
            }
        ),
    )
    first = await async_client.post(SIGNUP_PATH, json=_signup_payload())
    assert first.status_code == HTTPStatus.OK

    unknown = await async_client.post(
        SIGNUP_PATH, json=_signup_payload(email=OTHER_EMAIL, license_key=UNKNOWN_LICENSE_KEY)
    )
    bound = await async_client.post(
        SIGNUP_PATH, json=_signup_payload(email=OTHER_EMAIL, license_key=LICENSE_KEY)
    )
    refunded = await async_client.post(
        SIGNUP_PATH, json=_signup_payload(email=OTHER_EMAIL, license_key=REFUNDED_LICENSE_KEY)
    )

    fingerprints = {_fingerprint(unknown), _fingerprint(bound), _fingerprint(refunded)}
    assert len(fingerprints) == 1
    assert bound.status_code == HTTPStatus.BAD_REQUEST
    assert bound.json() == {"detail": DETAIL_INVALID_LICENSE}
    assert await _count_users(db_session) == 1
    assert await _count_entitlements(db_session) == 1
    assert await _count_bindings(db_session) == 1
    assert _log_carries_marker(caplog, ALREADY_BOUND_MARKER)


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products", "disable_rate_limit")
async def test_raw_license_key_never_reaches_rows_logs_or_responses(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """After a claim and after every refusal, the key exists nowhere but the request."""
    caplog.set_level(logging.DEBUG)
    monkeypatch.setattr(
        VERIFY_SEAM,
        _make_keyed_verify_stub(
            {
                LICENSE_KEY: _license_result(email=OTHER_EMAIL),
                REFUNDED_LICENSE_KEY: _license_result(reversal=_Reversal(refunded=True)),
            }
        ),
    )
    responses = [
        await async_client.post(SIGNUP_PATH, json=_signup_payload()),
        await async_client.post(
            SIGNUP_PATH, json=_signup_payload(email=OTHER_EMAIL, license_key=UNKNOWN_LICENSE_KEY)
        ),
        await async_client.post(
            SIGNUP_PATH, json=_signup_payload(email=OTHER_EMAIL, license_key=LICENSE_KEY)
        ),
        await async_client.post(
            SIGNUP_PATH, json=_signup_payload(email=OTHER_EMAIL, license_key=REFUNDED_LICENSE_KEY)
        ),
    ]

    assert [response.status_code for response in responses] == [
        HTTPStatus.OK,
        HTTPStatus.BAD_REQUEST,
        HTTPStatus.BAD_REQUEST,
        HTTPStatus.BAD_REQUEST,
    ]
    for key in (LICENSE_KEY, UNKNOWN_LICENSE_KEY, REFUNDED_LICENSE_KEY):
        assert key not in caplog.text
        assert all(key.encode() not in response.content for response in responses)
        held = await _rows_holding(db_session, key)
        assert {name: count for name, count in held.items() if count} == {}
    assert await _count_bindings(db_session) == 1


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products")
async def test_losing_the_binding_race_leaves_no_orphan_account(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the UNIQUE constraint, not a pre-check, refuses the claim, nothing survives.

    Both pre-checks are silenced so the binding insert reaches the constraint
    — the only defence that holds under a real race — and the User row
    flushed in the same transaction must roll back with it.
    """
    calls: list[tuple[str, str]] = []
    results = {ALLOWED_PRODUCT_ALPHA: _license_result(email=OTHER_EMAIL)}
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub(results, calls))
    first = await async_client.post(SIGNUP_PATH, json=_signup_payload())
    assert first.status_code == HTTPStatus.OK
    monkeypatch.setattr(FIND_BINDING_SEAM, AsyncMock(return_value=None))

    response = await async_client.post(SIGNUP_PATH, json=_signup_payload(email=OTHER_EMAIL))

    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert response.json() == {"detail": DETAIL_INVALID_LICENSE}
    assert await _count_users(db_session) == 1
    assert await _count_entitlements(db_session) == 1
    assert await _count_bindings(db_session) == 1


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products", "disable_rate_limit")
async def test_two_racers_presenting_one_key_yield_one_account(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two simultaneous signups with the same key: one account, one generic refusal."""
    calls: list[tuple[str, str]] = []
    results = {ALLOWED_PRODUCT_ALPHA: _license_result(email=THIRD_EMAIL)}
    monkeypatch.setattr(VERIFY_SEAM, _make_verify_stub(results, calls))
    payloads = [_signup_payload(email=SIGNUP_EMAIL), _signup_payload(email=OTHER_EMAIL)]
    assert len(payloads) == CONCURRENT_RACERS

    responses = await asyncio.gather(
        *[concurrent_async_client.post(SIGNUP_PATH, json=payload) for payload in payloads]
    )

    assert sorted(response.status_code for response in responses) == RACER_STATUSES
    loser = next(r for r in responses if r.status_code == HTTPStatus.BAD_REQUEST)
    assert loser.json() == {"detail": DETAIL_INVALID_LICENSE}
    assert await _count_via(concurrent_session_factory, User) == 1
    assert await _count_via(concurrent_session_factory, Entitlement) == 1
    assert await _count_via(concurrent_session_factory, LicenseBinding) == 1


@pytest.mark.asyncio
@pytest.mark.usefixtures("allowlisted_products", "disable_rate_limit")
async def test_a_bound_key_is_charged_against_the_invalid_license_cap(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Grinding a stolen-but-bound key counts against the throttle like an unknown one.

    ADR 0008 Decision 6: ten bound-key attempts spend the whole hourly budget
    and the eleventh is refused with 429 before Gumroad is contacted, exactly
    as ten unknown keys would be. Were the bound key free, every one of them
    would answer 400 forever.
    """
    monkeypatch.setattr(
        VERIFY_SEAM, _make_keyed_verify_stub({LICENSE_KEY: _license_result(email=OTHER_EMAIL)})
    )
    first = await async_client.post(SIGNUP_PATH, json=_signup_payload())
    assert first.status_code == HTTPStatus.OK

    for attempt in range(INVALID_LICENSE_MAX_PER_HOUR):
        bound = await async_client.post(
            SIGNUP_PATH,
            json=_signup_payload(email=f"{INVALID_ATTEMPT_EMAIL_PREFIX}{attempt}@example.com"),
        )
        assert bound.status_code == HTTPStatus.BAD_REQUEST
        assert bound.json()["detail"] == DETAIL_INVALID_LICENSE
    throttled = await async_client.post(SIGNUP_PATH, json=_signup_payload(email=THIRD_EMAIL))

    assert throttled.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert throttled.json()["detail"] == DETAIL_THROTTLED


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
