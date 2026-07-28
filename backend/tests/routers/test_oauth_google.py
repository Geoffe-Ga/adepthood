"""Google OAuth sign-in tests for POST /auth/oauth/google.

This is the second authentication path into an account, so the contract is
pinned end to end: an id_token that fails cryptographic verification is a 401
that writes nothing; a known ``(provider, subject)`` pair logs in; a verified
email links a Google identity onto an existing account; a brand-new verified
email plus a valid APTITUDE license creates the account; and everything else
is one byte-identical 409 that reveals nothing about which check failed.

Every test runs offline — the Google JWKS client and the outbound Gumroad
verify are both replaced with in-process stubs — and the raw id_token is
never allowed to reach a log line or a response body.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from typing import TYPE_CHECKING
from urllib.parse import urlparse

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlmodel import SQLModel, select

from domain.entitlements import PRODUCT_IDS_ENV_VAR
from integrations.gumroad import GumroadUnavailableError
from models.auth_identity import AuthIdentity, AuthProvider
from models.entitlement import Entitlement
from models.user import User
from rate_limit import INVALID_LICENSE_MAX_PER_HOUR
from schemas.gumroad import GumroadLicenseResult, GumroadPurchase
from services.oauth_google import (
    GOOGLE_JWKS_URL,
    GOOGLE_OAUTH_CLIENT_IDS_ENV_VAR,
    JWKS_TIMEOUT_SECONDS,
    build_jwk_client,
)
from services.oidc import OIDCIdentity

if TYPE_CHECKING:
    from httpx import AsyncClient, Response
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

pytestmark = pytest.mark.real_license_gate

OAUTH_PATH = "/auth/oauth/google"
LOGIN_PATH = "/auth/login"

# Test seams. The JWKS seam is the only thing standing between this suite and
# a live network fetch of Google's signing keys, so every test replaces it.
JWKS_SEAM = "services.oauth_google._get_jwk_client"
VERIFY_SEAM = "domain.entitlements.verify_license"

ALLOWED_PRODUCT_ALPHA = "prod_alpha"
ALLOWED_PRODUCT_BETA = "prod_beta"
ALLOWLIST = f"{ALLOWED_PRODUCT_ALPHA},{ALLOWED_PRODUCT_BETA}"

TEST_CLIENT_ID = "1000000001-adepthood.apps.googleusercontent.com"  # pragma: allowlist secret
OTHER_CLIENT_ID = "2000000002-attacker.apps.googleusercontent.com"  # pragma: allowlist secret
TEST_KID = "adepthood-test-signing-key"
GOOGLE_ISSUER_URL = "https://accounts.google.com"
GOOGLE_ISSUER_BARE = "accounts.google.com"
EVIL_ISSUER = "https://evil.example.com"
GOOGLE_JWKS_HOSTS = ("www.googleapis.com", "accounts.google.com")

RS256_ALGORITHM = "RS256"
HS256_ALGORITHM = "HS256"
NONE_ALGORITHM = "none"
JWT_TYPE = "JWT"
RSA_PUBLIC_EXPONENT = 65537
RSA_KEY_SIZE = 2048

TOKEN_LIFETIME = timedelta(minutes=5)
EXPIRED_ISSUED_AGO = timedelta(hours=2)
EXPIRED_EXPIRY_AGO = timedelta(hours=1)
SOFT_DELETED_AT = datetime(2026, 1, 1, tzinfo=UTC)

EXISTING_EMAIL = "seeker@example.com"
EXISTING_EMAIL_MIXED_CASE = "SeeKeR@Example.COM"
NEW_EMAIL = "newcomer@example.com"
SECOND_NEW_EMAIL = "second-newcomer@example.com"
UNCLAIMED_EMAIL = "stranger@example.com"
UNVERIFIED_NEW_EMAIL = "unverified-newcomer@example.com"
DISPLAY_NAME = "Seeker Example"

KNOWN_SUBJECT = "google-sub-known-0001"
FRESH_SUBJECT = "google-sub-fresh-0002"
NEW_SUBJECT = "google-sub-new-0003"
SECOND_NEW_SUBJECT = "google-sub-new-0004"
RACING_SUBJECT = "google-sub-racing-0005"
NO_KEY_SUBJECT = "google-sub-nokey-0006"
BAD_KEY_SUBJECT = "google-sub-badkey-0007"
COLLISION_SUBJECT = "google-sub-collision-0008"
UNVERIFIED_SUBJECT = "google-sub-unverified-0009"
THROTTLE_SUBJECT_PREFIX = "google-sub-throttle-"
THROTTLE_EMAIL_PREFIX = "throttle-attempt-"

VALID_LICENSE_KEY = "AAAA1111-BBBB-2222-OAUTH"  # pragma: allowlist secret
SECOND_LICENSE_KEY = "CCCC3333-DDDD-4444-OAUTH"  # pragma: allowlist secret
INVALID_LICENSE_KEY = "ZZZZ9999-YYYY-8888-OAUTH"  # pragma: allowlist secret
SALE_ID = "S-OAUTH-1"
LICENSE_USES = 1
COURSE_ACCESS_KIND = "course_access"
GUMROAD_DOWN_MESSAGE = "gumroad unavailable in test"

SEEDED_PASSWORD_HASH = (
    "$2b$12$seededplaceholderdigestforteststhatneveraccepts"  # pragma: allowlist secret
)
ARBITRARY_PASSWORD = "any-password-at-all"  # pragma: allowlist secret
BCRYPT_PREFIX = "$2"

SEEDED_TIMEZONE = "America/New_York"
SIGNUP_TIMEZONE = "America/Los_Angeles"

DETAIL_INVALID_TOKEN = "invalid_oauth_token"
DETAIL_NEEDS_LICENSE = "needs_license"
DETAIL_UNAVAILABLE = "license_verification_unavailable"
DETAIL_THROTTLED = "too_many_license_attempts"
DETAIL_INVALID_CREDENTIALS = "invalid_credentials"

REASON_INVALID_TOKEN = "oauth_invalid_token"
REASON_LOGIN = "oauth_login"
REASON_LINKED = "oauth_linked"
REASON_SIGNUP = "oauth_signup"
REASON_NEEDS_LICENSE = "oauth_needs_license"
REASON_ACCOUNT_GATED = "oauth_account_gated"

JWT_SEGMENT_COUNT = 3
# Upper bound the JWKS fetch timeout must stay under. Anything longer holds a
# shared thread-pool worker for longer than an interactive request should.
MAX_ACCEPTABLE_JWKS_TIMEOUT = 10.0
MAX_ID_TOKEN_LENGTH = 4096
OVER_LENGTH_ID_TOKEN = "a" * (MAX_ID_TOKEN_LENGTH + 1)
GARBAGE_TOKEN = "not.a.jwt"
OAUTH_RATE_LIMIT_PER_MINUTE = 5
CONCURRENT_REQUESTS = 2
SOCIAL_ACCOUNT_COUNT = 2
BYTE_IDENTICAL_REJECTIONS = 4

# One 2048-bit keypair per module: generation is expensive enough that doing it
# per test would dominate the suite's runtime. The second, unrelated key exists
# only to forge a well-formed token signed by the wrong hand.
_SIGNING_KEY = rsa.generate_private_key(
    public_exponent=RSA_PUBLIC_EXPONENT,
    key_size=RSA_KEY_SIZE,
)
_FORGER_KEY = rsa.generate_private_key(
    public_exponent=RSA_PUBLIC_EXPONENT,
    key_size=RSA_KEY_SIZE,
)
_PUBLIC_KEY_PEM = _SIGNING_KEY.public_key().public_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PublicFormat.SubjectPublicKeyInfo,
)


def _epoch(offset: timedelta) -> int:
    """Return the UNIX timestamp ``offset`` away from now."""
    return int((datetime.now(UTC) + offset).timestamp())


def _claims(**overrides: object) -> dict[str, object]:
    """Build a Google-shaped id_token claim set with per-test overrides."""
    base: dict[str, object] = {
        "iss": GOOGLE_ISSUER_URL,
        "aud": TEST_CLIENT_ID,
        "sub": KNOWN_SUBJECT,
        "email": EXISTING_EMAIL,
        "email_verified": True,
        "name": DISPLAY_NAME,
        "iat": _epoch(-timedelta(seconds=1)),
        "exp": _epoch(TOKEN_LIFETIME),
    }
    base.update(overrides)
    return base


def _sign_rs256(claims: dict[str, object], private_key: rsa.RSAPrivateKey) -> str:
    """Sign ``claims`` as an RS256 JWT carrying the module's ``kid`` header."""
    return jwt.encode(
        claims,
        private_key,
        algorithm=RS256_ALGORITHM,
        headers={"kid": TEST_KID},
    )


def _mint_token(**overrides: object) -> str:
    """Mint a legitimately signed Google id_token."""
    return _sign_rs256(_claims(**overrides), _SIGNING_KEY)


def _mint_forged_token(**overrides: object) -> str:
    """Mint a well-formed id_token signed by a key Google never published."""
    return _sign_rs256(_claims(**overrides), _FORGER_KEY)


def _mint_token_missing(claim: str, **overrides: object) -> str:
    """Mint a legitimately signed token with ``claim`` removed entirely."""
    claims = _claims(**overrides)
    del claims[claim]
    return _sign_rs256(claims, _SIGNING_KEY)


def _b64url(raw: bytes) -> bytes:
    """Base64url-encode ``raw`` without padding, as JWT compact serialization does."""
    return base64.urlsafe_b64encode(raw).rstrip(b"=")


def _b64url_json(data: dict[str, object]) -> bytes:
    """Base64url-encode ``data`` as compact JSON."""
    return _b64url(json.dumps(data, separators=(",", ":")).encode("utf-8"))


def _signing_input(algorithm: str, **overrides: object) -> bytes:
    """Return the ``header.payload`` bytes a JWT signature is computed over."""
    header: dict[str, object] = {"alg": algorithm, "kid": TEST_KID, "typ": JWT_TYPE}
    return b".".join((_b64url_json(header), _b64url_json(_claims(**overrides))))


def _mint_unsigned_token(**overrides: object) -> str:
    """Mint an ``alg: none`` token: real claims, no signature at all."""
    return _signing_input(NONE_ALGORITHM, **overrides).decode("ascii") + "."


def _mint_algorithm_confusion_token(**overrides: object) -> str:
    """Mint the RS256-to-HS256 downgrade: HMAC keyed by the RSA public key PEM.

    A verifier that accepts the token's own ``alg`` header would treat the
    public key as a shared secret, letting anyone who can read the JWKS mint
    tokens for any account.
    """
    signing_input = _signing_input(HS256_ALGORITHM, **overrides)
    signature = hmac.new(_PUBLIC_KEY_PEM, signing_input, hashlib.sha256).digest()
    return b".".join((signing_input, _b64url(signature))).decode("ascii")


def _oauth_payload(
    id_token: str,
    license_key: str | None = None,
    timezone: str | None = None,
) -> dict[str, str]:
    """Build the request body; ``None`` arguments omit their field entirely."""
    payload = {"id_token": id_token}
    if license_key is not None:
        payload["license_key"] = license_key
    if timezone is not None:
        payload["timezone"] = timezone
    return payload


def _log_carries_marker(caplog: pytest.LogCaptureFixture, marker: str) -> bool:
    """Return True when ``marker`` appears in captured text or as a reason_code."""
    if marker in caplog.text:
        return True
    return any(getattr(record, "reason_code", None) == marker for record in caplog.records)


def _fingerprint(response: Response) -> tuple[int, str | None, bytes]:
    """Return everything an unauthenticated observer can see about a rejection."""
    return (response.status_code, response.headers.get("content-type"), response.content)


async def _needs_license_reference(client: AsyncClient) -> tuple[int, str | None, bytes]:
    """Fingerprint the canonical step-5 rejection every other refusal must match.

    A brand-new verified email with no license key is the most ordinary way to
    be turned away.  Any other refusal that differs from this by even one byte
    is an oracle, so the gated-account tests compare against it directly rather
    than restating the expected body.
    """
    return _fingerprint(
        await client.post(
            OAUTH_PATH,
            json=_oauth_payload(_mint_token(sub=NO_KEY_SUBJECT, email=NEW_EMAIL)),
        )
    )


def _license_result(email: str) -> GumroadLicenseResult:
    """Build a live, unreversed Gumroad verify answer for ``email``."""
    return GumroadLicenseResult(
        success=True,
        uses=LICENSE_USES,
        purchase=GumroadPurchase(
            email=email,
            product_id=ALLOWED_PRODUCT_ALPHA,
            sale_id=SALE_ID,
            refunded=False,
            chargebacked=False,
            disputed=False,
            dispute_won=False,
        ),
    )


@dataclass(frozen=True)
class _StubSigningKey:
    """What a JWKS client hands back for a token's ``kid``: a key carrier."""

    key: object


class _StubJWKClient:
    """Offline stand-in for ``PyJWKClient`` — answers from the module keypair."""

    def __init__(self, key: object) -> None:
        """Hold the public key every lookup resolves to."""
        self._key = key
        self.lookups: list[str] = []

    def get_signing_key_from_jwt(self, token: str) -> _StubSigningKey:
        """Record the lookup and return the module's public signing key."""
        self.lookups.append(token)
        return _StubSigningKey(self._key)


class _LicenseVerifier:
    """Network-free stand-in for the outbound Gumroad license verify."""

    def __init__(self) -> None:
        """Start with no grants recorded and Gumroad nominally healthy."""
        self.calls: list[tuple[str, str]] = []
        self.results: dict[str, GumroadLicenseResult] = {}
        self.unavailable = False

    def grant(self, license_key: str, email: str) -> None:
        """Make ``license_key`` verify as a live purchase made by ``email``."""
        self.results[license_key] = _license_result(email)

    async def verify(
        self,
        product_id: str,
        license_key: str,
        **_kwargs: object,
    ) -> GumroadLicenseResult | None:
        """Answer for ``license_key``, or raise when Gumroad is stubbed down."""
        self.calls.append((product_id, license_key))
        if self.unavailable:
            raise GumroadUnavailableError(GUMROAD_DOWN_MESSAGE)
        return self.results.get(license_key)


@pytest.fixture(autouse=True)
def offline_jwks(monkeypatch: pytest.MonkeyPatch) -> _StubJWKClient:
    """Replace Google's JWKS client so no test in this module hits the network."""
    client = _StubJWKClient(_SIGNING_KEY.public_key())

    def _factory() -> _StubJWKClient:
        return client

    monkeypatch.setattr(JWKS_SEAM, _factory)
    return client


@pytest.fixture(autouse=True)
def google_client_ids(monkeypatch: pytest.MonkeyPatch) -> str:
    """Configure the single accepted OAuth audience for the module."""
    monkeypatch.setenv(GOOGLE_OAUTH_CLIENT_IDS_ENV_VAR, TEST_CLIENT_ID)
    return TEST_CLIENT_ID


@pytest.fixture
def allowlisted_products(monkeypatch: pytest.MonkeyPatch) -> str:
    """Point the APTITUDE product allowlist at the two test product ids."""
    monkeypatch.setenv(PRODUCT_IDS_ENV_VAR, ALLOWLIST)
    return ALLOWLIST


@pytest.fixture
def license_verifier(
    monkeypatch: pytest.MonkeyPatch,
    allowlisted_products: str,  # noqa: ARG001 — side-effect: configures the allowlist
) -> _LicenseVerifier:
    """Stub the outbound Gumroad verify while leaving the real license gate in place."""
    verifier = _LicenseVerifier()
    monkeypatch.setattr(VERIFY_SEAM, verifier.verify)
    return verifier


def _user_id(user: User) -> int:
    """Return a committed user's primary key, failing loudly when absent."""
    if user.id is None:
        msg = "user id missing after commit"
        raise RuntimeError(msg)
    return user.id


async def _count_rows(session: AsyncSession, model: type[SQLModel]) -> int:
    """Return the number of ``model`` rows visible to ``session``."""
    result = await session.execute(select(func.count()).select_from(model))
    return int(result.scalar_one())


async def _count_rows_via(
    factory: async_sessionmaker[AsyncSession],
    model: type[SQLModel],
) -> int:
    """Return the number of ``model`` rows in the concurrency fixture's database."""
    async with factory() as session:
        return await _count_rows(session, model)


async def _seed_user(
    session: AsyncSession,
    email: str = EXISTING_EMAIL,
    *,
    is_active: bool = True,
    deleted_at: datetime | None = None,
) -> User:
    """Insert a password-authenticated user and return the committed row."""
    user = User(
        email=email,
        password_hash=SEEDED_PASSWORD_HASH,
        timezone=SEEDED_TIMEZONE,
        is_active=is_active,
        deleted_at=deleted_at,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user


async def _seed_identity(
    session: AsyncSession,
    user_id: int,
    subject: str,
    email: str = EXISTING_EMAIL,
) -> AuthIdentity:
    """Insert a linked Google identity for ``user_id`` and return the committed row."""
    identity = AuthIdentity(
        user_id=user_id,
        provider=AuthProvider.GOOGLE,
        subject=subject,
        email_at_link_time=email,
    )
    session.add(identity)
    await session.commit()
    await session.refresh(identity)
    return identity


async def _seed_user_via(
    factory: async_sessionmaker[AsyncSession],
    email: str = EXISTING_EMAIL,
) -> int:
    """Insert a user into the concurrency fixture's database and return its id."""
    async with factory() as session:
        return _user_id(await _seed_user(session, email))


async def _only_identity(session: AsyncSession) -> AuthIdentity:
    """Return the single AuthIdentity row, asserting there is exactly one."""
    identities = (await session.execute(select(AuthIdentity))).scalars().all()
    assert len(identities) == 1
    return identities[0]


# ---------------------------------------------------------------------------
# Model contract
# ---------------------------------------------------------------------------


def test_auth_provider_enum_names_the_two_supported_providers() -> None:
    """The provider discriminator stores the wire values Apple and Google use."""
    assert AuthProvider.GOOGLE.value == "google"
    assert AuthProvider.APPLE.value == "apple"


def test_oidc_identity_exposes_the_claims_the_ladder_reads() -> None:
    """The verifier's return value carries exactly the claims the ladder consumes."""
    identity = OIDCIdentity(
        subject=KNOWN_SUBJECT,
        email=EXISTING_EMAIL,
        email_verified=True,
        name=DISPLAY_NAME,
    )

    assert identity.subject == KNOWN_SUBJECT
    assert identity.email == EXISTING_EMAIL
    assert identity.email_verified is True
    assert identity.name == DISPLAY_NAME


def test_google_jwks_url_is_https_on_a_google_host() -> None:
    """Signing keys are fetched over TLS from Google, never plaintext or elsewhere."""
    parsed = urlparse(GOOGLE_JWKS_URL)

    assert parsed.scheme == "https"
    assert parsed.hostname in GOOGLE_JWKS_HOSTS


@pytest.mark.asyncio
async def test_provider_subject_pair_is_unique(db_session: AsyncSession) -> None:
    """Two rows may not claim the same Google subject — that would fork an account."""
    user = await _seed_user(db_session)
    await _seed_identity(db_session, _user_id(user), KNOWN_SUBJECT)

    duplicate = AuthIdentity(
        user_id=_user_id(user),
        provider=AuthProvider.GOOGLE,
        subject=KNOWN_SUBJECT,
        email_at_link_time=EXISTING_EMAIL,
    )
    db_session.add(duplicate)

    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


# ---------------------------------------------------------------------------
# A. Cryptographic verification
# ---------------------------------------------------------------------------

_UNVERIFIABLE_TOKENS = (
    pytest.param(_mint_forged_token(), id="signed-by-an-unrelated-key"),
    pytest.param(_mint_token(aud=OTHER_CLIENT_ID), id="audience-is-another-client"),
    pytest.param(_mint_token(iss=EVIL_ISSUER), id="issuer-is-not-google"),
    pytest.param(
        _mint_token(iat=_epoch(-EXPIRED_ISSUED_AGO), exp=_epoch(-EXPIRED_EXPIRY_AGO)),
        id="expired",
    ),
    pytest.param(_mint_unsigned_token(), id="alg-none-unsigned"),
    pytest.param(_mint_algorithm_confusion_token(), id="rs256-to-hs256-confusion"),
    pytest.param(GARBAGE_TOKEN, id="structurally-not-a-jwt"),
    pytest.param(_mint_token_missing("sub"), id="valid-signature-no-subject"),
    # A token carrying no ``exp`` never expires, so absence has to be rejected
    # outright rather than skipped the way an unasserted claim would be.
    pytest.param(_mint_token_missing("exp"), id="valid-signature-no-expiry"),
    pytest.param(_mint_token_missing("iat"), id="valid-signature-no-issued-at"),
)


@pytest.mark.asyncio
@pytest.mark.parametrize("id_token", _UNVERIFIABLE_TOKENS)
async def test_unverifiable_token_is_401_and_writes_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
    id_token: str,
) -> None:
    """Every failure of cryptographic verification is the same 401 with zero writes."""
    caplog.set_level(logging.INFO)

    response = await async_client.post(OAUTH_PATH, json=_oauth_payload(id_token))

    assert response.status_code == HTTPStatus.UNAUTHORIZED
    assert response.json()["detail"] == DETAIL_INVALID_TOKEN
    assert "token" not in response.json()
    assert await _count_rows(db_session, AuthIdentity) == 0
    assert await _count_rows(db_session, User) == 0
    assert _log_carries_marker(caplog, REASON_INVALID_TOKEN)


@pytest.mark.asyncio
@pytest.mark.parametrize("client_ids", [None, ""], ids=["unset", "blank"])
async def test_unconfigured_client_ids_reject_even_a_perfect_token(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    client_ids: str | None,
) -> None:
    """With no configured audience the verifier fails closed rather than open."""
    if client_ids is None:
        monkeypatch.delenv(GOOGLE_OAUTH_CLIENT_IDS_ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(GOOGLE_OAUTH_CLIENT_IDS_ENV_VAR, client_ids)
    user = await _seed_user(db_session)
    await _seed_identity(db_session, _user_id(user), KNOWN_SUBJECT)

    response = await async_client.post(OAUTH_PATH, json=_oauth_payload(_mint_token()))

    assert response.status_code == HTTPStatus.UNAUTHORIZED
    assert response.json()["detail"] == DETAIL_INVALID_TOKEN
    assert await _count_rows(db_session, AuthIdentity) == 1


@pytest.mark.asyncio
async def test_over_length_id_token_is_rejected_before_verification(
    async_client: AsyncClient,
    db_session: AsyncSession,
    offline_jwks: _StubJWKClient,
) -> None:
    """An id_token past the schema ceiling is a 422; no key lookup is attempted."""
    response = await async_client.post(OAUTH_PATH, json=_oauth_payload(OVER_LENGTH_ID_TOKEN))

    assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert offline_jwks.lookups == []
    assert await _count_rows(db_session, User) == 0
    assert await _count_rows(db_session, AuthIdentity) == 0


@pytest.mark.asyncio
async def test_sixth_attempt_in_a_minute_is_rate_limited(async_client: AsyncClient) -> None:
    """The endpoint carries the login-strength 5/minute per-IP cap."""
    id_token = _mint_forged_token()

    for _ in range(OAUTH_RATE_LIMIT_PER_MINUTE):
        response = await async_client.post(OAUTH_PATH, json=_oauth_payload(id_token))
        assert response.status_code == HTTPStatus.UNAUTHORIZED

    throttled = await async_client.post(OAUTH_PATH, json=_oauth_payload(id_token))

    assert throttled.status_code == HTTPStatus.TOO_MANY_REQUESTS


# ---------------------------------------------------------------------------
# B. Step 2 — an already-linked identity logs in
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_known_identity_logs_in_without_creating_a_row(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A stored (google, sub) pair mints a JWT for its user and links nothing new."""
    caplog.set_level(logging.INFO)
    user = await _seed_user(db_session)
    await _seed_identity(db_session, _user_id(user), KNOWN_SUBJECT)

    response = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(_mint_token(sub=KNOWN_SUBJECT)),
    )

    assert response.status_code == HTTPStatus.OK
    body = response.json()
    assert body["user_id"] == _user_id(user)
    assert body["timezone"] == SEEDED_TIMEZONE
    assert len(body["token"].split(".")) == JWT_SEGMENT_COUNT
    assert await _count_rows(db_session, AuthIdentity) == 1
    assert await _count_rows(db_session, User) == 1
    assert _log_carries_marker(caplog, REASON_LOGIN)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "issuer",
    [GOOGLE_ISSUER_URL, GOOGLE_ISSUER_BARE],
    ids=["https-issuer", "bare-issuer"],
)
async def test_both_google_issuer_spellings_are_accepted(
    async_client: AsyncClient,
    db_session: AsyncSession,
    issuer: str,
) -> None:
    """Google mints both ``accounts.google.com`` spellings; both must verify."""
    user = await _seed_user(db_session)
    await _seed_identity(db_session, _user_id(user), KNOWN_SUBJECT)

    response = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(_mint_token(sub=KNOWN_SUBJECT, iss=issuer)),
    )

    assert response.status_code == HTTPStatus.OK
    assert response.json()["user_id"] == _user_id(user)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("is_active", "deleted_at"),
    [(False, None), (True, SOFT_DELETED_AT)],
    ids=["soft-disabled", "soft-deleted"],
)
async def test_linked_identity_on_a_gated_account_issues_no_token(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
    is_active: bool,
    deleted_at: datetime | None,
) -> None:
    """A gated account is refused with the generic 409, never a telltale 401.

    401 is reserved for "this token did not verify".  Spending it here would
    tell any holder of a valid Google token whether the identity it names is
    attached to a banned Adepthood account, so the refusal collapses onto the
    same body an unknown account gets.
    """
    caplog.set_level(logging.INFO)
    user = await _seed_user(db_session, is_active=is_active, deleted_at=deleted_at)
    await _seed_identity(db_session, _user_id(user), KNOWN_SUBJECT)

    response = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(_mint_token(sub=KNOWN_SUBJECT)),
    )

    assert response.status_code == HTTPStatus.CONFLICT
    assert response.json()["detail"] == DETAIL_NEEDS_LICENSE
    assert "token" not in response.json()
    assert _fingerprint(response) == await _needs_license_reference(async_client)
    assert _log_carries_marker(caplog, REASON_ACCOUNT_GATED)


# ---------------------------------------------------------------------------
# C. Step 3 — link by verified email
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_verified_email_links_onto_the_existing_account(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A verified provider email matches case-insensitively and links exactly one row."""
    caplog.set_level(logging.INFO)
    user = await _seed_user(db_session)

    response = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(
            _mint_token(sub=FRESH_SUBJECT, email=EXISTING_EMAIL_MIXED_CASE, email_verified=True)
        ),
    )

    assert response.status_code == HTTPStatus.OK
    assert response.json()["user_id"] == _user_id(user)
    assert await _count_rows(db_session, User) == 1

    identity = await _only_identity(db_session)
    assert identity.provider == AuthProvider.GOOGLE
    assert identity.subject == FRESH_SUBJECT
    assert identity.user_id == _user_id(user)
    assert identity.email_at_link_time.lower() == EXISTING_EMAIL
    assert _log_carries_marker(caplog, REASON_LINKED)


@pytest.mark.asyncio
@pytest.mark.usefixtures("license_verifier")
async def test_unverified_email_never_links_to_an_existing_account(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An unverified provider email is the takeover vector; it must not link."""
    caplog.set_level(logging.INFO)
    user = await _seed_user(db_session)

    response = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(
            _mint_token(sub=FRESH_SUBJECT, email=EXISTING_EMAIL, email_verified=False)
        ),
    )

    assert response.status_code == HTTPStatus.CONFLICT
    assert response.json()["detail"] == DETAIL_NEEDS_LICENSE
    assert "token" not in response.json()
    assert await _count_rows(db_session, AuthIdentity) == 0
    assert await _count_rows(db_session, User) == 1

    await db_session.refresh(user)
    assert user.email == EXISTING_EMAIL
    assert user.is_active is True
    assert _log_carries_marker(caplog, REASON_NEEDS_LICENSE)


@pytest.mark.asyncio
@pytest.mark.usefixtures("license_verifier")
@pytest.mark.parametrize(
    "email_verified",
    ["true", "True", 1],
    ids=["string-true", "string-True", "integer-one"],
)
async def test_only_a_real_boolean_true_counts_as_a_verified_email(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_verified: object,
) -> None:
    """A truthy non-boolean ``email_verified`` must not be read as verified.

    Google sends a JSON boolean, but other providers send the string ``"true"``
    -- and a verifier that accepts anything truthy is exactly how an address
    nobody proved ends up linked to somebody else's account.  Pinned because
    the guard is a single ``is True`` that a well-meaning "be tolerant"
    refactor would quietly widen.
    """
    await _seed_user(db_session)

    response = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(
            _mint_token(sub=FRESH_SUBJECT, email=EXISTING_EMAIL, email_verified=email_verified)
        ),
    )

    assert response.status_code == HTTPStatus.CONFLICT
    assert response.json()["detail"] == DETAIL_NEEDS_LICENSE
    assert await _count_rows(db_session, AuthIdentity) == 0
    assert await _count_rows(db_session, User) == 1


def test_jwks_client_bounds_its_fetch_timeout() -> None:
    """The JWKS fetch must not inherit PyJWT's 30-second default.

    An unrecognised ``kid`` makes the client refetch immediately, bypassing the
    key-set cache, and that fetch occupies a worker in the same default thread
    pool bcrypt runs in.  An unbounded timeout therefore lets unauthenticated
    junk tokens park threads that logins and signups need.
    """
    client = build_jwk_client()

    assert client.timeout == JWKS_TIMEOUT_SECONDS
    assert 0 < JWKS_TIMEOUT_SECONDS <= MAX_ACCEPTABLE_JWKS_TIMEOUT


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("is_active", "deleted_at"),
    [(False, None), (True, SOFT_DELETED_AT)],
    ids=["soft-disabled", "soft-deleted"],
)
async def test_verified_email_never_links_onto_a_gated_account(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
    is_active: bool,
    deleted_at: datetime | None,
) -> None:
    """Probing a banned account with a verified provider email reveals nothing.

    Linking here would hand a fresh session to an account an operator has
    already shut, and answering differently from an unknown email would let an
    attacker who controls the address confirm the ban exists.  Both are closed
    by the same generic 409.
    """
    caplog.set_level(logging.INFO)
    await _seed_user(db_session, is_active=is_active, deleted_at=deleted_at)

    response = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(
            _mint_token(sub=FRESH_SUBJECT, email=EXISTING_EMAIL, email_verified=True)
        ),
    )

    assert response.status_code == HTTPStatus.CONFLICT
    assert response.json()["detail"] == DETAIL_NEEDS_LICENSE
    assert _fingerprint(response) == await _needs_license_reference(async_client)
    assert await _count_rows(db_session, AuthIdentity) == 0
    assert await _count_rows(db_session, User) == 1
    assert _log_carries_marker(caplog, REASON_ACCOUNT_GATED)


@pytest.mark.asyncio
async def test_concurrent_links_create_exactly_one_identity(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Two simultaneous first-links for one subject converge on a single row."""
    user_id = await _seed_user_via(concurrent_session_factory)
    payload = _oauth_payload(_mint_token(sub=RACING_SUBJECT, email=EXISTING_EMAIL))

    responses = await asyncio.gather(
        *[
            concurrent_async_client.post(OAUTH_PATH, json=payload)
            for _ in range(CONCURRENT_REQUESTS)
        ]
    )

    assert [response.status_code for response in responses] == [HTTPStatus.OK] * CONCURRENT_REQUESTS
    assert {response.json()["user_id"] for response in responses} == {user_id}
    assert await _count_rows_via(concurrent_session_factory, AuthIdentity) == 1
    assert await _count_rows_via(concurrent_session_factory, User) == 1


# ---------------------------------------------------------------------------
# D. Step 4 — license-gated account creation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_new_email_with_valid_license_creates_the_account(
    async_client: AsyncClient,
    db_session: AsyncSession,
    license_verifier: _LicenseVerifier,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A verified stranger holding a license gets a user, an entitlement, and a link."""
    caplog.set_level(logging.INFO)
    license_verifier.grant(VALID_LICENSE_KEY, NEW_EMAIL)

    response = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(
            _mint_token(sub=NEW_SUBJECT, email=NEW_EMAIL),
            license_key=VALID_LICENSE_KEY,
            timezone=SIGNUP_TIMEZONE,
        ),
    )

    assert response.status_code == HTTPStatus.OK
    body = response.json()
    assert body["timezone"] == SIGNUP_TIMEZONE
    assert len(body["token"].split(".")) == JWT_SEGMENT_COUNT

    users = (await db_session.execute(select(User))).scalars().all()
    assert len(users) == 1
    assert users[0].email == NEW_EMAIL
    assert users[0].timezone == SIGNUP_TIMEZONE
    assert users[0].id == body["user_id"]
    assert users[0].password_hash.startswith(BCRYPT_PREFIX)

    entitlements = (await db_session.execute(select(Entitlement))).scalars().all()
    assert len(entitlements) == 1
    assert entitlements[0].kind == COURSE_ACCESS_KIND
    assert entitlements[0].user_id == body["user_id"]
    assert entitlements[0].revoked_at is None

    identity = await _only_identity(db_session)
    assert identity.subject == NEW_SUBJECT
    assert identity.user_id == body["user_id"]
    assert _log_carries_marker(caplog, REASON_SIGNUP)


@pytest.mark.asyncio
async def test_social_accounts_get_distinct_unusable_passwords(
    async_client: AsyncClient,
    db_session: AsyncSession,
    license_verifier: _LicenseVerifier,
) -> None:
    """A social-only account cannot be logged into with a password, and its secret is unique."""
    license_verifier.grant(VALID_LICENSE_KEY, NEW_EMAIL)
    license_verifier.grant(SECOND_LICENSE_KEY, SECOND_NEW_EMAIL)

    first = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(
            _mint_token(sub=NEW_SUBJECT, email=NEW_EMAIL), license_key=VALID_LICENSE_KEY
        ),
    )
    second = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(
            _mint_token(sub=SECOND_NEW_SUBJECT, email=SECOND_NEW_EMAIL),
            license_key=SECOND_LICENSE_KEY,
        ),
    )
    assert first.status_code == HTTPStatus.OK
    assert second.status_code == HTTPStatus.OK

    hashes = (await db_session.execute(select(User.password_hash))).scalars().all()
    assert len(hashes) == SOCIAL_ACCOUNT_COUNT
    assert all(digest.startswith(BCRYPT_PREFIX) for digest in hashes)
    assert len(set(hashes)) == SOCIAL_ACCOUNT_COUNT

    login = await async_client.post(
        LOGIN_PATH,
        json={"email": NEW_EMAIL, "password": ARBITRARY_PASSWORD},
    )

    assert login.status_code == HTTPStatus.UNAUTHORIZED
    assert login.json()["detail"] == DETAIL_INVALID_CREDENTIALS
    assert "token" not in login.json()


@pytest.mark.asyncio
async def test_gumroad_outage_fails_closed_with_503(
    async_client: AsyncClient,
    db_session: AsyncSession,
    license_verifier: _LicenseVerifier,
) -> None:
    """An unreachable Gumroad answers 503 and creates nothing."""
    license_verifier.unavailable = True

    response = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(
            _mint_token(sub=NEW_SUBJECT, email=NEW_EMAIL), license_key=VALID_LICENSE_KEY
        ),
    )

    assert response.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert response.json()["detail"] == DETAIL_UNAVAILABLE
    assert await _count_rows(db_session, User) == 0
    assert await _count_rows(db_session, Entitlement) == 0
    assert await _count_rows(db_session, AuthIdentity) == 0


@pytest.mark.asyncio
async def test_concurrent_first_logins_create_exactly_one_account(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    license_verifier: _LicenseVerifier,
) -> None:
    """Two simultaneous licensed first-logins yield one user and one identity."""
    license_verifier.grant(VALID_LICENSE_KEY, NEW_EMAIL)
    payload = _oauth_payload(
        _mint_token(sub=RACING_SUBJECT, email=NEW_EMAIL),
        license_key=VALID_LICENSE_KEY,
    )

    responses = await asyncio.gather(
        *[
            concurrent_async_client.post(OAUTH_PATH, json=payload)
            for _ in range(CONCURRENT_REQUESTS)
        ]
    )

    assert all(response.status_code != HTTPStatus.INTERNAL_SERVER_ERROR for response in responses)
    assert await _count_rows_via(concurrent_session_factory, User) == 1
    assert await _count_rows_via(concurrent_session_factory, AuthIdentity) == 1


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_invalid_license_attempts_share_the_hourly_cap(
    async_client: AsyncClient,
    license_verifier: _LicenseVerifier,  # noqa: ARG001 — no key ever verifies
) -> None:
    """The OAuth path is not a bypass of signup's invalid-license throttle."""
    for attempt in range(INVALID_LICENSE_MAX_PER_HOUR):
        id_token = _mint_token(
            sub=f"{THROTTLE_SUBJECT_PREFIX}{attempt}",
            email=f"{THROTTLE_EMAIL_PREFIX}{attempt}@example.com",
        )
        response = await async_client.post(
            OAUTH_PATH,
            json=_oauth_payload(id_token, license_key=INVALID_LICENSE_KEY),
        )
        assert response.status_code == HTTPStatus.CONFLICT
        assert response.json()["detail"] == DETAIL_NEEDS_LICENSE

    final_token = _mint_token(sub=f"{THROTTLE_SUBJECT_PREFIX}final", email=UNCLAIMED_EMAIL)
    throttled = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(final_token, license_key=INVALID_LICENSE_KEY),
    )

    assert throttled.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert throttled.json()["detail"] == DETAIL_THROTTLED


# ---------------------------------------------------------------------------
# E. Step 5 — anti-enumeration and secret hygiene
# ---------------------------------------------------------------------------


def _needs_license_payloads() -> tuple[dict[str, str], ...]:
    """The four distinct ways to land on step 5, which must be indistinguishable."""
    return (
        _oauth_payload(_mint_token(sub=NO_KEY_SUBJECT, email=NEW_EMAIL)),
        _oauth_payload(
            _mint_token(sub=BAD_KEY_SUBJECT, email=SECOND_NEW_EMAIL),
            license_key=INVALID_LICENSE_KEY,
        ),
        _oauth_payload(
            _mint_token(sub=COLLISION_SUBJECT, email=EXISTING_EMAIL, email_verified=False)
        ),
        _oauth_payload(
            _mint_token(sub=UNVERIFIED_SUBJECT, email=UNVERIFIED_NEW_EMAIL, email_verified=False),
            license_key=VALID_LICENSE_KEY,
        ),
    )


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_every_needs_license_rejection_is_byte_identical(
    async_client: AsyncClient,
    db_session: AsyncSession,
    license_verifier: _LicenseVerifier,
) -> None:
    """No 409 reveals whether the email exists, whether it is verified, or key validity."""
    await _seed_user(db_session)
    license_verifier.grant(VALID_LICENSE_KEY, UNVERIFIED_NEW_EMAIL)

    fingerprints = [
        _fingerprint(await async_client.post(OAUTH_PATH, json=payload))
        for payload in _needs_license_payloads()
    ]

    assert len(fingerprints) == BYTE_IDENTICAL_REJECTIONS
    assert all(status == HTTPStatus.CONFLICT for status, _, _ in fingerprints)
    assert all(DETAIL_NEEDS_LICENSE.encode() in body for _, _, body in fingerprints)
    assert len(set(fingerprints)) == 1
    assert await _count_rows(db_session, User) == 1
    assert await _count_rows(db_session, Entitlement) == 0
    assert await _count_rows(db_session, AuthIdentity) == 0


@pytest.mark.asyncio
async def test_raw_id_token_never_reaches_a_log_or_a_response(
    async_client: AsyncClient,
    db_session: AsyncSession,
    license_verifier: _LicenseVerifier,  # noqa: ARG001 — keeps the gate network-free
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A leaked id_token is a replayable credential; no ladder path may echo one."""
    user = await _seed_user(db_session)
    await _seed_identity(db_session, _user_id(user), KNOWN_SUBJECT)
    tokens = (
        _mint_forged_token(sub=KNOWN_SUBJECT),
        _mint_token(sub=KNOWN_SUBJECT),
        _mint_token(sub=FRESH_SUBJECT, email=UNCLAIMED_EMAIL),
    )

    caplog.set_level(logging.INFO)
    responses = [
        await async_client.post(OAUTH_PATH, json=_oauth_payload(id_token)) for id_token in tokens
    ]

    # Pin that all three ladder rungs were actually walked, so the absence
    # assertions below cannot pass vacuously against an unrouted endpoint.
    assert [response.status_code for response in responses] == [
        HTTPStatus.UNAUTHORIZED,
        HTTPStatus.OK,
        HTTPStatus.CONFLICT,
    ]

    haystack = caplog.text + "".join(response.text for response in responses)
    for id_token in tokens:
        assert id_token not in haystack
        for segment in id_token.split("."):
            assert segment not in haystack
